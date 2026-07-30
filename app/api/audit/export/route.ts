/**
 * GET /api/audit/export
 *
 * Streams the audit log as NDJSON (Newline Delimited JSON).
 * Each line is a JSON-serialised AuditExportRow.
 *
 * Access: admin, security, and compliance roles only.
 *
 * Query parameters (all optional):
 *   action    – filter by audit action (e.g. "stream.settle")
 *   actorId   – filter by actor ID
 *   targetId  – filter by target ID
 *   requestId – filter by originating request ID
 *   role      – filter by actor role
 *   q         – free-text search across serialised entry
 *   orgId     – filter by organisation ID (stored in entry metadata)
 *   startDate – filter by ISO-8601 timestamp (inclusive lower bound)
 *   endDate   – filter by ISO-8601 timestamp (inclusive upper bound)
 *   limit     – max rows to stream (1–250, default 250)
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
import type { AuditActorRole, AuditListFilters } from "@/app/types/audit";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parseDateParam(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function buildFilters(request: Request): AuditListFilters {
  const { searchParams } = new URL(request.url);
  return {
    action: searchParams.get("action"),
    actorId: searchParams.get("actorId"),
    limit: parseLimit(searchParams.get("limit")),
    orgId: searchParams.get("orgId"),
    q: searchParams.get("q"),
    requestId: searchParams.get("requestId"),
    role: searchParams.get("role") as AuditActorRole | null,
    targetId: searchParams.get("targetId"),
    startDate: parseDateParam(searchParams.get("startDate")),
    endDate: parseDateParam(searchParams.get("endDate")),
  };
}

function resolveRequestId(request: Request): string {
  return (
    request.headers?.get?.("x-request-id") ??
    request.headers?.get?.("x-correlation-id") ??
    request.headers?.get?.("x-vercel-id") ??
    randomUUID()
  );
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
  const filters = buildFilters(request);

  const rows = auditLogStore.exportRows(filters);
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

// Mutations are never allowed on the audit log.
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
