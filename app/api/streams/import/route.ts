/**
 * POST /api/streams/import
 *
 * Bulk-import streams from a CSV payload.  Accepts:
 *   - `Content-Type: text/csv` — raw CSV body
 *   - `Content-Type: application/json` — `{ "csv": "<string>" }` or `{ "rows": [...] }`
 *
 * Query parameters:
 *   - `dryRun=true` — validate every row without persisting any stream or touching
 *     the idempotency store.
 *   - `dryRun=false` (default) — validate then persist valid rows; failed rows are
 *     skipped and duplicate rows are deduplicated without blocking the rest of the
 *     batch (partial-import semantics). Requires an `Idempotency-Key` header.
 *
 * Headers:
 *   - `Idempotency-Key` — required when `dryRun=false`. Requests are fingerprinted
 *     by their canonical row list. Replaying the same key and canonical rows returns
 *     the original 207 body; reusing the key with different rows returns 409
 *     `IDEMPOTENCY_CONFLICT`; a concurrent replay while the original request is still
 *     in flight returns 409 `IDEMPOTENCY_IN_FLIGHT`.
 *
 * CSV columns (case-insensitive header):
 *   `recipient`, `rate`|`amount`, `schedule`, `token`|`asset`, `memo`, `external_id`
 *
 * Row identity & deduplication:
 *   Each row's dedupe key is its `external_id` (when provided) or the SHA-256 hash
 *   of the normalised `(recipient, rate, schedule, token, memo)` tuple. Duplicate
 *   keys within the same file or previously imported by the same caller are skipped
 *   and reported with `status: "duplicate"` and the existing `streamId`.
 *
 * Timeout safety:
 *   Persistence is bounded by the route timeout (`withRouteTimeout`). Each row is
 *   recorded as soon as it is persisted, and an aborted/timed-out request releases
 *   its in-flight idempotency reservation so a retry reports already-persisted rows
 *   as `duplicate` and imports only the remaining rows.
 *
 * ## Response (207)
 *
 * ```json
 * {
 *   "summary": { "total": 3, "valid": 2, "failed": 1, "imported": 2 },
 *   "results": [
 *     { "row": 1, "status": "imported", "streamId": "stream-abc123" },
 *     { "row": 2, "status": "duplicate", "streamId": "stream-abc123" },
 *     { "row": 3, "status": "error", "errors": [...] }
 *   ]
 * }
 * ```
 *
 * ## Errors
 *
 * | Status | Code                       | Reason                                           |
 * |--------|----------------------------|--------------------------------------------------|
 * | 400    | `INVALID_CSV`              | CSV body is empty or unparseable                 |
 * | 400    | `TOO_MANY_ROWS`            | More than 500 rows                               |
 * | 400    | `INVALID_REQUEST`          | Body is not valid JSON                           |
 * | 400    | `IDEMPOTENCY_KEY_REQUIRED` | Missing `Idempotency-Key` when `dryRun=false`    |
 * | 409    | `IDEMPOTENCY_CONFLICT`     | `Idempotency-Key` reused with different rows     |
 * | 409    | `IDEMPOTENCY_IN_FLIGHT`    | Concurrent request with same `Idempotency-Key`   |
 * | 504    | `GATEWAY_TIMEOUT`          | Persistence exceeded the route deadline          |
 * | 207    | —                          | Multi-Status batch result                        |
 */

import { createHash } from "crypto";
import { NextResponse } from "next/server";
import {
  computeFingerprint,
  getStore,
  IDEMPOTENCY_TTL_MS,
  idempotencyToken,
  setIdempotency,
} from "@/app/lib/db";
import { errorResponse } from "@/app/lib/errors/server";
import { logger } from "@/app/lib/logger";
import { parseCreateStreamBody, type NormalisedCreateStreamInput } from "@/app/lib/stream-validation";
import { checkTokenAllowed, normaliseToken } from "@/app/lib/token-allowlist";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { TimeoutError } from "@/app/lib/with-timeout";
import { ROUTE_TIMEOUT_MS, withRouteTimeout } from "@/src/middleware/timeout";

const MAX_ROWS = 500;

export interface RowResult {
  row: number;
  status: "imported" | "error" | "valid" | "duplicate";
  streamId?: string;
  errors?: RowError[];
}

export interface RowError {
  field: string;
  code: string;
  message: string;
}

export interface ImportSummary {
  total: number;
  valid: number;
  failed: number;
  imported?: number;
}

interface NormalisedRow {
  recipient: string;
  rate: string;
  schedule: string;
  token: string;
  memo: string;
  external_id: string;
}

interface StoredIdempotencyRecord {
  state?: "in_flight" | "completed";
  fingerprint: string;
  expiresAt: number;
  status?: number;
  body?: unknown;
}

interface StoredRowDedupeRecord {
  streamId: string;
  expiresAt: number;
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

// ── Row normalisation & identity ──────────────────────────────────────────────

function normaliseRow(raw: Record<string, string>): NormalisedRow {
  return {
    recipient: (raw.recipient ?? "").trim(),
    rate: (raw.rate || raw.amount || "").trim(),
    schedule: (raw.schedule ?? "").trim(),
    token: (raw.token || raw.asset || "").trim(),
    memo: (raw.memo ?? "").trim(),
    external_id: (raw.external_id ?? raw.externalId ?? "").trim(),
  };
}

function canonicaliseRowForFingerprint(row: NormalisedRow): NormalisedRow {
  let token = row.token || "XLM";
  try {
    token = normaliseToken(token);
  } catch {
    // Keep raw token when malformed so distinct invalid payloads do not collide.
  }

  return {
    recipient: row.recipient,
    rate: row.rate,
    schedule: row.schedule.toLowerCase(),
    token,
    memo: row.memo,
    external_id: row.external_id,
  };
}

export function computeRowKey(row: NormalisedRow, normalisedToken: string): string {
  if (row.external_id) {
    return row.external_id;
  }

  const canonicalTuple = JSON.stringify([
    row.recipient,
    row.rate,
    row.schedule.toLowerCase(),
    normalisedToken,
    row.memo,
  ]);
  return createHash("sha256").update(canonicalTuple).digest("hex");
}

function resolveCallerId(request: Request): string {
  return (
    request.headers.get("Actor-Wallet-Address")?.trim() ||
    request.headers.get("x-tenant-id")?.trim() ||
    request.headers.get("X-API-Key")?.trim() ||
    request.headers.get("authorization")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "anonymous"
  );
}

// ── Row validation ────────────────────────────────────────────────────────────

async function validateRow(
  row: NormalisedRow,
): Promise<{ errors: RowError[]; normalisedToken?: string; parsed?: NormalisedCreateStreamInput }> {
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

  if (errors.length > 0) return { errors };

  // Use the shared stream validation for deeper checks
  const parseResult = parseCreateStreamBody(row as unknown as Record<string, unknown>);
  if (!parseResult.success) {
    for (const fe of parseResult.errors) {
      errors.push({
        field: fe.field,
        code: fe.code,
        message: fe.message,
      });
    }
    return { errors };
  }

  // Token allowlist check
  const tokenStr = row.token || "XLM";
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
    return { errors };
  }

  const allowlistResult = await checkTokenAllowed(normalisedToken);
  if (!allowlistResult.accepted) {
    errors.push({
      field: "token",
      code: "TOKEN_NOT_ALLOWED",
      message: allowlistResult.reason,
    });
    return { errors };
  }

  return { errors, normalisedToken, parsed: parseResult.data };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { idempotencyStore, streamRepository } = getStore();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "true";

  let rows: Record<string, string>[];

  // ── 1. Parse input ─────────────────────────────────────────────────────────
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("text/csv")) {
    const text = await request.text();
    rows = parseCSV(text);
    if (rows.length === 0) {
      return errorResponse(
        "INVALID_CSV",
        "CSV body is empty, has no data rows, or is unparseable.",
        400,
      );
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
            external_id: String(obj.external_id ?? obj.externalId ?? ""),
          };
        }
        return {} as Record<string, string>;
      });
    } else {
      return errorResponse(
        "INVALID_REQUEST",
        "Request must include a 'csv' string or a 'rows' array.",
        400,
      );
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

  const normalisedRows = rows.map(normaliseRow);
  const authenticatedActor = tryAuthenticateRequest(request);
  const senderAddress = authenticatedActor?.walletAddress ?? null;
  const ownership: "individual" | "unclaimed" = authenticatedActor ? "individual" : "unclaimed";

  // ── 3. Idempotency check & reservation (skipped on dryRun) ─────────────────
  const callerId = resolveCallerId(request);
  let reqToken: string | null = null;
  let fingerprint = "";

  if (!dryRun) {
    const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!idempotencyKey) {
      return errorResponse(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key header is required when dryRun is false.",
        400,
      );
    }

    const canonicalRows = normalisedRows.map(canonicaliseRowForFingerprint);
    fingerprint = computeFingerprint("POST", "/api/streams/import", canonicalRows);
    reqToken = idempotencyToken(`streams.import.req.${callerId}`, idempotencyKey);

    const existingRaw = idempotencyStore.get(reqToken) as
      | Partial<StoredIdempotencyRecord>
      | undefined;

    if (existingRaw !== undefined) {
      if (
        typeof existingRaw.fingerprint !== "string" ||
        typeof existingRaw.expiresAt !== "number" ||
        existingRaw.expiresAt < Date.now()
      ) {
        idempotencyStore.delete(reqToken);
      } else if (existingRaw.state === "in_flight") {
        return errorResponse(
          "IDEMPOTENCY_IN_FLIGHT",
          "A request with this Idempotency-Key is currently in flight.",
          409,
        );
      } else if (existingRaw.fingerprint !== fingerprint) {
        return errorResponse(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key has already been used with a different request payload.",
          409,
        );
      } else if (typeof existingRaw.status === "number" && existingRaw.body !== undefined) {
        return NextResponse.json(existingRaw.body, {
          status: existingRaw.status,
          headers: { "Idempotency-Replay": "true" },
        });
      } else {
        idempotencyStore.delete(reqToken);
      }
    }

    // Reserve key while request is in flight
    const reservation: StoredIdempotencyRecord = {
      state: "in_flight",
      fingerprint,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    };
    idempotencyStore.set(reqToken, reservation);
  }

  // ── 4. Process each row under the route timeout ────────────────────────────
  const timeoutMs = Number(process.env.ROUTE_TIMEOUT_MS) || ROUTE_TIMEOUT_MS;
  let completed = false;

  const releaseReservation = () => {
    if (!completed && reqToken) {
      idempotencyStore.delete(reqToken);
    }
  };

  try {
    return await withRouteTimeout(
      request,
      async (signal) => {
        signal.addEventListener("abort", releaseReservation, { once: true });

        const results: RowResult[] = [];
        const seenInBatch = new Map<string, string | undefined>();
        let valid = 0;
        let failed = 0;
        let imported = 0;

        for (let i = 0; i < normalisedRows.length; i++) {
          if (signal.aborted) {
            throw new TimeoutError(timeoutMs);
          }

          const row = normalisedRows[i];
          const { errors: rowErrors, normalisedToken, parsed } = await validateRow(row);

          if (signal.aborted) {
            throw new TimeoutError(timeoutMs);
          }

          if (rowErrors.length > 0 || !normalisedToken || !parsed) {
            results.push({ row: i + 1, status: "error", errors: rowErrors });
            failed++;
            continue;
          }

          valid++;
          const rowKey = computeRowKey(row, normalisedToken);

          if (dryRun) {
            if (seenInBatch.has(rowKey)) {
              results.push({ row: i + 1, status: "duplicate" });
            } else {
              seenInBatch.set(rowKey, undefined);
              results.push({ row: i + 1, status: "valid" });
            }
            continue;
          }

          // In-file duplicate check
          if (seenInBatch.has(rowKey)) {
            results.push({
              row: i + 1,
              status: "duplicate",
              streamId: seenInBatch.get(rowKey),
            });
            continue;
          }

          // Cross-request caller-scoped duplicate check
          const rowDedupeToken = idempotencyToken(`streams.import.row.${callerId}`, rowKey);
          const existingRow = idempotencyStore.get(rowDedupeToken) as
            | Partial<StoredRowDedupeRecord>
            | undefined;

          if (existingRow !== undefined) {
            if (
              typeof existingRow.streamId === "string" &&
              typeof existingRow.expiresAt === "number" &&
              existingRow.expiresAt >= Date.now() &&
              streamRepository.streams.has(existingRow.streamId)
            ) {
              seenInBatch.set(rowKey, existingRow.streamId);
              results.push({
                row: i + 1,
                status: "duplicate",
                streamId: existingRow.streamId,
              });
              continue;
            }
            idempotencyStore.delete(rowDedupeToken);
          }

          if (signal.aborted) {
            throw new TimeoutError(timeoutMs);
          }

          const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          const newStream = {
            createdAt: now,
            id,
            nextAction: "start" as const,
            rate: parsed.rate,
            recipient: parsed.recipient,
            schedule: parsed.schedule,
            status: "draft" as const,
            updatedAt: now,
            token: normalisedToken,
            memo: row.memo || undefined,
            senderAddress,
            ownership,
          };

          streamRepository.streams.set(id, newStream);
          idempotencyStore.set(rowDedupeToken, {
            streamId: id,
            expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
          });
          seenInBatch.set(rowKey, id);
          imported++;
          results.push({ row: i + 1, status: "imported", streamId: id });
        }

        // ── 5. Build response ────────────────────────────────────────────────
        const summary: ImportSummary = { total: normalisedRows.length, valid, failed };
        if (!dryRun) {
          summary.imported = imported;
        }

        const payload = { summary, results };

        if (reqToken) {
          setIdempotency(idempotencyStore, reqToken, fingerprint, 207, payload);
        }
        completed = true;

        logger.info("Stream import completed", {
          dryRun,
          total: normalisedRows.length,
          valid,
          failed,
          imported: dryRun ? undefined : imported,
        });

        return NextResponse.json(payload, {
          status: 207,
          headers: dryRun ? undefined : { "Idempotency-Replay": "false" },
        });
      },
      timeoutMs,
    );
  } finally {
    releaseReservation();
  }
}
