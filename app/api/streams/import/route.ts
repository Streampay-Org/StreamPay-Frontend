/**
 * POST /api/streams/import
 *
 * Bulk-import streams from a CSV payload.  Accepts:
 *   - `Content-Type: text/csv` — raw CSV body
 *   - `Content-Type: application/json` — `{ "csv": "<string>" }` or `{ "rows": [...] }`
 *
 * Query parameters:
 *   - `dryRun=true` — validate every row without persisting any stream.
 *   - `dryRun=false` (default) — validate then persist valid rows; failed rows are
 *     skipped but do not block the rest of the batch (partial-import semantics).
 *
 * CSV columns (case-insensitive header):
 *   `recipient`, `rate`|`amount`, `schedule`, `token`|`asset`, `memo`
 *
 * Each row is validated independently.  The endpoint returns a 207 Multi-Status
 * with per-row results and a summary block.
 *
 * ## Response (207)
 *
 * ```json
 * {
 *   "summary": { "total": 3, "valid": 2, "failed": 1, "imported": 2 },
 *   "results": [
 *     { "row": 1, "status": "imported", "streamId": "stream-abc123" },
 *     { "row": 2, "status": "error", "errors": [...] }
 *   ]
 * }
 * ```
 *
 * ## Errors
 *
 * | Status | Code                  | Reason                                |
 * |--------|-----------------------|---------------------------------------|
 * | 400    | `INVALID_CSV`         | CSV body is empty or unparseable       |
 * | 400    | `TOO_MANY_ROWS`       | More than 500 rows                     |
 * | 400    | `INVALID_REQUEST`     | Body is not valid JSON                 |
 * | 207    | —                     | Partial success (some rows failed)     |
 */

import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { validateCreateStreamBody } from "@/app/lib/stream-validation";
import { checkTokenAllowed, normaliseToken } from "@/app/lib/token-allowlist";

const MAX_ROWS = 500;

interface RowResult {
  row: number;
  status: "imported" | "error" | "valid";
  streamId?: string;
  errors?: RowError[];
}

interface RowError {
  field: string;
  code: string;
  message: string;
}

interface ImportSummary {
  total: number;
  valid: number;
  failed: number;
  imported?: number;
}

// ── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0 || values.every((v) => v.trim().length === 0)) continue;
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j]?.trim() ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        values.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }

  values.push(current);
  return values;
}

// ── Row normalisation ─────────────────────────────────────────────────────────

function normaliseRow(
  raw: Record<string, string>,
): Record<string, string> {
  const row: Record<string, string> = {};

  row.recipient = raw.recipient ?? "";
  row.rate = raw.rate || raw.amount || "";
  row.schedule = raw.schedule ?? "";
  row.token = raw.token || raw.asset || "";
  row.memo = raw.memo ?? "";

  return row;
}

// ── Row validation ────────────────────────────────────────────────────────────

async function validateRow(
  row: Record<string, string>,
  index: number,
): Promise<RowError[]> {
  const errors: RowError[] = [];

  if (!row.recipient) {
    errors.push({
      field: "recipient",
      code: "MISSING_FIELD",
      message: "recipient is required.",
    });
  }

  if (!row.rate) {
    errors.push({
      field: "rate",
      code: "MISSING_FIELD",
      message: "rate or amount is required.",
    });
  }

  if (!row.schedule) {
    errors.push({
      field: "schedule",
      code: "MISSING_FIELD",
      message: "schedule is required (e.g. day, week, month).",
    });
  }

  if (errors.length > 0) return errors;

  // Use the shared stream validation for deeper checks
  const fieldErrors = validateCreateStreamBody(row as unknown as Record<string, unknown>);
  for (const fe of fieldErrors) {
    errors.push({
      field: fe.field,
      code: fe.code,
      message: fe.message,
    });
  }

  if (errors.length > 0) return errors;

  // Token allowlist check
  const tokenStr = row.token?.trim() || "XLM";
  let normalisedToken: string;
  try {
    normalisedToken = normaliseToken(tokenStr);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({
      field: "token",
      code: "INVALID_TOKEN",
      message: `Invalid token format: ${msg}`,
    });
    return errors;
  }

  const allowlistResult = await checkTokenAllowed(normalisedToken);
  if (!allowlistResult.accepted) {
    errors.push({
      field: "token",
      code: "TOKEN_NOT_ALLOWED",
      message: allowlistResult.reason,
    });
  }

  return errors;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { streamRepository } = getStore();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "true";

  let rows: Record<string, string>[];

  // ── 1. Parse input ─────────────────────────────────────────────────────────
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("text/csv")) {
    const text = await request.text();
    rows = parseCSV(text);
    if (rows.length === 0) {
      return errorResponse("INVALID_CSV", "CSV body is empty, has no data rows, or is unparseable.", 400);
    }
  } else {
    let body: { csv?: string; rows?: unknown[] };
    try {
      body = await request.json();
    } catch {
      return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    }

    if (typeof body.csv === "string") {
      if (body.csv.trim().length === 0) {
        return errorResponse("INVALID_CSV", "CSV string is empty.", 400);
      }
      rows = parseCSV(body.csv);
      if (rows.length === 0) {
        return errorResponse("INVALID_CSV", "CSV string has no data rows.", 400);
      }
    } else if (Array.isArray(body.rows)) {
      rows = body.rows.map((r) => {
        if (typeof r === "object" && r !== null && !Array.isArray(r)) {
          const obj = r as Record<string, string>;
          return {
            recipient: String(obj.recipient ?? ""),
            rate: String(obj.rate ?? obj.amount ?? ""),
            schedule: String(obj.schedule ?? ""),
            token: String(obj.token ?? obj.asset ?? ""),
            memo: String(obj.memo ?? ""),
          };
        }
        return {} as Record<string, string>;
      });
    } else {
      return errorResponse("INVALID_REQUEST", "Request must include a 'csv' string or a 'rows' array.", 400);
    }
  }

  // ── 2. Validate batch size ─────────────────────────────────────────────────
  if (rows.length > MAX_ROWS) {
    return errorResponse(
      "TOO_MANY_ROWS",
      `Maximum ${MAX_ROWS} rows per import. Received ${rows.length}.`,
      400,
    );
  }

  // ── 3. Process each row ────────────────────────────────────────────────────
  const results: RowResult[] = [];
  let valid = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = normaliseRow(rows[i]);
    const rowErrors = await validateRow(row, i);

    if (rowErrors.length > 0) {
      results.push({ row: i + 1, status: "error", errors: rowErrors });
      failed++;
      continue;
    }

    valid++;

    if (dryRun) {
      results.push({ row: i + 1, status: "valid" });
    } else {
      const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const tokenStr = row.token?.trim() || "XLM";
      let normalisedToken: string;
      try {
        normalisedToken = normaliseToken(tokenStr);
      } catch {
        normalisedToken = "XLM";
      }

      const newStream = {
        createdAt: now,
        id,
        nextAction: "start" as const,
        rate: row.rate,
        recipient: row.recipient,
        schedule: row.schedule,
        status: "draft" as const,
        updatedAt: now,
        token: normalisedToken,
        memo: row.memo || undefined,
      };

      streamRepository.streams.set(id, newStream);
      results.push({ row: i + 1, status: "imported", streamId: id });
    }
  }

  // ── 4. Build response ──────────────────────────────────────────────────────
  const summary: ImportSummary = { total: rows.length, valid, failed };
  if (!dryRun) {
    summary.imported = valid;
  }

  logger.info("Stream import completed", {
    dryRun,
    total: rows.length,
    valid,
    failed,
    imported: dryRun ? undefined : valid,
  });

  return NextResponse.json({ summary, results }, { status: 207 });
}
