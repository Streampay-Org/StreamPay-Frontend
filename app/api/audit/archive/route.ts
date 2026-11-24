/**
 * GET /api/audit/archive
 *
 * Streams the archived audit log (soft-archived by retention plus deep-archived
 * cold-storage entries) as NDJSON (Newline Delimited JSON). Each line is a
 * JSON-serialised AuditExportRow with the same redacted projection as
 * `GET /api/audit?export=ndjson`, so archived downloads never leak unredacted
 * target accounts.
 *
 * Access: admin, security, and compliance roles only — the same export role
 * set as `GET /api/audit/export`. Archived audit data is sensitive cold-storage
 * material, so it must never be downloadable without an export-role actor.
 *
 * Query parameters (all optional):
 *   limit – max rows to stream (1–250, default 250)
 *
 * Response headers:
 *   content-type          – application/x-ndjson; charset=utf-8
 *   x-audit-chain-intact  – tamper-evident chain integrity status
 *   x-audit-retention-days – configured retention window
 *   x-request-id          – correlation ID for the request
 *   x-content-type-options – nosniff
 *   cache-control         – no-store
 */

import { requireAuditLogAccess } from "@/app/lib/auth";
import { AUDIT_LOG_RETENTION_DAYS, auditLogStore } from "@/app/lib/audit-log";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

function createErrorResponse(code: string, message: string, status: number) {
  const requestId = randomUUID();
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    {
      status,
      headers: { "x-request-id": requestId },
    },
  );
}

function parseLimit(value: string | null, defaultValue = 250): number {
  if (value === null || value === undefined) return defaultValue;
  const trimmed = value.trim();
  if (trimmed === "") return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (parsed < 1) return 1;
  if (parsed > 250) return 250;
  return parsed;
}

function resolveRequestId(request: Request): string {
  return (
    request.headers?.get?.("x-request-id") ??
    request.headers?.get?.("x-correlation-id") ??
    request.headers?.get?.("x-vercel-id") ??
    randomUUID()
  );
}

export async function GET(request: Request) {
  const actor = requireAuditLogAccess(request, "export");
  if (actor instanceof NextResponse) {
    return actor;
  }

  const { searchParams } = new URL(request.url);
  const requestId = resolveRequestId(request);

  const rows = auditLogStore.exportArchivedRows(parseLimit(searchParams.get("limit")));
  const chainIntact = auditLogStore.assertIntegrity();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const row of rows) {
        controller.enqueue(encoder.encode(JSON.stringify(row) + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-audit-chain-intact": String(chainIntact),
      "x-audit-retention-days": String(AUDIT_LOG_RETENTION_DAYS),
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
    status: 200,
  });
}

// The audit log (including its archive) is append-only and read-only via API.
export async function POST() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405);
}

export async function PUT() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405);
}

export async function PATCH() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405);
}

export async function DELETE() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is read-only", 405);
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
