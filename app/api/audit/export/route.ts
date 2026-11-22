/**
 * GET /api/audit/export
 *
 * Streams the audit log as NDJSON (Newline Delimited JSON) by default. Each
 * line is a JSON-serialised AuditExportRow. Requesting `format=csv` (or
 * `Accept: text/csv`) streams the same redacted rows as CSV.
 *
 * Access: admin, security, and compliance roles only.
 *
 * Query parameters (all optional):
 *   action    – filter by audit action (e.g. "stream.settle")
 *   actorId   – filter by actor ID
 *   targetId  – filter by target ID
 *   requestId – filter by originating request ID
 *   role      – filter by actor role (must be a valid role)
 *   q         – free-text search across serialised entry
 *   orgId     – filter by organisation ID (stored in entry metadata)
 *   startDate – filter by ISO-8601 timestamp (inclusive lower bound)
 *   endDate   – filter by ISO-8601 timestamp (inclusive upper bound)
 *   limit     – integer 1–250 (default 250)
 *   format    – "ndjson" (default) or "csv"
 *
 * Response headers:
 *   content-type          – application/x-ndjson or text/csv; charset=utf-8
 *   x-audit-chain-intact  – tamper-evident chain integrity status
 *   x-audit-retention-days – configured retention window
 *   x-request-id          – correlation ID for the request
 *   x-content-type-options – nosniff
 *   cache-control         – no-store
 */

import { requireAuditLogAccess } from "@/app/lib/auth";
import { AUDIT_LOG_RETENTION_DAYS, auditLogStore } from "@/app/lib/audit-log";
import type {
  AuditActorRole,
  AuditExportRow,
  AuditListFilters,
} from "@/app/types/audit";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 250;

const VALID_ROLES = new Set<AuditActorRole>([
  "user",
  "support",
  "admin",
  "finance",
  "security",
  "compliance",
  "system",
]);

/**
 * ISO-8601 date or date-time. A timezone is optional for date-time values;
 * dates without a time are treated as UTC midnight by `Date`.
 */
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

type ExportFormat = "csv" | "ndjson";

class InvalidQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createErrorResponse(
  code: string,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
) {
  const requestId = randomUUID();
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    {
      status,
      headers: { "x-request-id": requestId, ...extraHeaders },
    },
  );
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_LIMIT;

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidQueryError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new InvalidQueryError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }

  return parsed;
}

function parseDateParam(param: string, value: string | null): string | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (!ISO_DATE_PATTERN.test(trimmed)) {
    throw new InvalidQueryError(
      "INVALID_DATE_FILTER",
      `${param} must be a valid ISO-8601 date`,
    );
  }

  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new InvalidQueryError(
      "INVALID_DATE_FILTER",
      `${param} must be a valid ISO-8601 date`,
    );
  }

  return date.toISOString();
}

function parseRole(value: string | null): AuditActorRole | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (!VALID_ROLES.has(trimmed as AuditActorRole)) {
    throw new InvalidQueryError(
      "INVALID_ROLE_FILTER",
      `role must be one of: ${Array.from(VALID_ROLES).join(", ")}`,
    );
  }

  return trimmed as AuditActorRole;
}

function buildFilters(request: Request): AuditListFilters {
  const { searchParams } = new URL(request.url);
  const startDate = parseDateParam("startDate", searchParams.get("startDate"));
  const endDate = parseDateParam("endDate", searchParams.get("endDate"));

  if (startDate && endDate && startDate > endDate) {
    throw new InvalidQueryError(
      "INVALID_DATE_RANGE",
      "startDate must be before or equal to endDate",
    );
  }

  return {
    action: searchParams.get("action"),
    actorId: searchParams.get("actorId"),
    limit: parseLimit(searchParams.get("limit")),
    orgId: searchParams.get("orgId"),
    q: searchParams.get("q"),
    requestId: searchParams.get("requestId"),
    role: parseRole(searchParams.get("role")),
    targetId: searchParams.get("targetId"),
    startDate,
    endDate,
  };
}

function resolveFormat(request: Request): ExportFormat {
  const { searchParams } = new URL(request.url);
  const requested = (
    searchParams.get("format") ??
    searchParams.get("export") ??
    ""
  )
    .trim()
    .toLowerCase();

  if (requested === "") {
    const accept = request.headers?.get?.("accept")?.toLowerCase() ?? "";
    return accept.includes("text/csv") ? "csv" : "ndjson";
  }

  if (requested === "ndjson" || requested === "csv") {
    return requested;
  }

  throw new InvalidQueryError(
    "INVALID_EXPORT_FORMAT",
    "format must be one of: ndjson, csv",
  );
}

function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Spreadsheet applications treat cells beginning with `=`, `+`, `-` or `@` as
 * formulas. Prefix them with an apostrophe so exported metadata cannot execute
 * when opened in a spreadsheet.
 */
function formulaSafe(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function escapeCsvField(value: unknown): string {
  const text = formulaSafe(stringifyCsvValue(value));
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function serializeMetadata(metadata: AuditExportRow["metadata"]): string {
  if (!metadata) return "";

  return Object.entries(metadata)
    .map(([key, value]) => `${key}=${formulaSafe(stringifyCsvValue(value))}`)
    .join("; ");
}

const CSV_HEADERS = [
  "id",
  "actorId",
  "actorRole",
  "targetType",
  "targetId",
  "redactedTargetAccount",
  "action",
  "beforeHash",
  "afterHash",
  "diffHash",
  "requestId",
  "timestamp",
  "prevHash",
  "entryHash",
  "retentionUntil",
  "redactionPolicy",
  "metadata",
];

function toCsvRow(row: AuditExportRow): string {
  return [
    row.id,
    row.actorId,
    row.actorRole,
    row.targetType,
    row.targetId,
    row.redactedTargetAccount,
    row.action,
    row.beforeHash,
    row.afterHash,
    row.diffHash,
    row.requestId,
    row.timestamp,
    row.prevHash,
    row.entryHash,
    row.retentionUntil,
    row.redactionPolicy,
    serializeMetadata(row.metadata),
  ]
    .map(escapeCsvField)
    .join(",");
}

function resolveRequestId(request: Request): string {
  return (
    request.headers?.get?.("x-request-id") ??
    request.headers?.get?.("x-correlation-id") ??
    request.headers?.get?.("x-vercel-id") ??
    randomUUID()
  );
}

function createExportResponse(
  rows: AuditExportRow[],
  format: ExportFormat,
  chainIntact: boolean,
  requestId: string,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode(CSV_HEADERS.join(",") + "\n"));
        }

        for (const row of rows) {
          const line = format === "csv" ? toCsvRow(row) : JSON.stringify(row);
          controller.enqueue(encoder.encode(line + "\n"));
        }

        controller.close();
      } catch (error) {
        // Fail closed: never leave a partially written export open.
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/x-ndjson; charset=utf-8",
      "x-audit-chain-intact": String(chainIntact),
      "x-audit-retention-days": String(AUDIT_LOG_RETENTION_DAYS),
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
    status: 200,
  });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const actor = requireAuditLogAccess(request, "export");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const requestId = resolveRequestId(request);

  let format: ExportFormat;
  let filters: AuditListFilters;
  try {
    format = resolveFormat(request);
    filters = buildFilters(request);
  } catch (error) {
    if (error instanceof InvalidQueryError) {
      return createErrorResponse(error.code, error.message, 422);
    }
    throw error;
  }

  // exportRows applies the redacted export projection to every row and caps
  // the result at 250 entries, so the stream stays bounded and redacted.
  const rows = auditLogStore.exportRows(filters);
  const chainIntact = auditLogStore.assertIntegrity();

  return createExportResponse(rows, format, chainIntact, requestId);
}

// Mutations are never allowed on the audit log.
export async function POST() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405, {
    Allow: "GET, OPTIONS",
  });
}

export async function PUT() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405, {
    Allow: "GET, OPTIONS",
  });
}

export async function PATCH() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405, {
    Allow: "GET, OPTIONS",
  });
}

export async function DELETE() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405, {
    Allow: "GET, OPTIONS",
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      Allow: "GET, OPTIONS",
      "x-request-id": randomUUID(),
    },
    status: 204,
  });
}
