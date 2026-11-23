import { NextResponse } from "next/server";
import { requireAuditLogAccess } from "@/app/lib/auth";
import { AUDIT_LOG_RETENTION_DAYS, auditLogStore } from "@/app/lib/audit-log";
import type { AuditActorRole, AuditListFilters } from "@/app/types/audit";
import { AuditResponseSchema, type AuditResponseDTO } from "@/app/lib/dtos/audit.dto";
import { withRouteTimeout } from "@/src/middleware/timeout";

function createErrorResponse(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message, request_id: "mock-request-id" } }, { status });
}

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "50", 10);
  if (!Number.isFinite(parsed)) {
    return 50;
  }
  return Math.min(Math.max(parsed, 1), 250);
}

function buildFilters(request: Request): AuditListFilters {
  const { searchParams } = new URL(request.url);
  return {
    action: searchParams.get("action"),
    actorId: searchParams.get("actorId"),
    limit: parseLimit(searchParams.get("limit")),
    q: searchParams.get("q"),
    requestId: searchParams.get("requestId"),
    role: searchParams.get("role") as AuditActorRole | null,
    targetId: searchParams.get("targetId"),
    cursor: searchParams.get("cursor"),
  };
}

async function handleAuditGet(request: Request) {
  const { searchParams } = new URL(request.url);
  const exportFormat = searchParams.get("export");
  const actor = requireAuditLogAccess(request, exportFormat === "ndjson" ? "export" : "read");

  if (actor instanceof NextResponse) {
    return actor;
  }

  const filters = buildFilters(request);
  if (exportFormat && exportFormat !== "ndjson") {
    return createErrorResponse("INVALID_EXPORT_FORMAT", "Only export=ndjson is supported", 422);
  }

  if (filters.cursor) {
    try {
      const decoded = Buffer.from(filters.cursor, "base64").toString("utf-8");
      if (!decoded.includes("|")) {
        throw new Error();
      }
    } catch {
      return createErrorResponse("INVALID_CURSOR", "Malformed cursor", 422);
    }
  }

  if (exportFormat === "ndjson") {
    const rows = auditLogStore.exportRows(filters);
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    return new Response(body, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-audit-chain-intact": String(auditLogStore.assertIntegrity()),
        "x-audit-retention-days": String(AUDIT_LOG_RETENTION_DAYS),
      },
      status: 200,
    });
  }

  const { data, hasNext, nextCursor, total } = auditLogStore.getPaginated(filters);
  const payload = AuditResponseSchema.parse({
    access: {
      actorId: actor.actorId,
      role: actor.role,
    },
    data,
    links: {
      self: "/api/audit",
    },
    meta: {
      chainIntact: auditLogStore.assertIntegrity(),
      retentionDays: AUDIT_LOG_RETENTION_DAYS,
      total,
      hasNext,
      nextCursor,
    },
  });

  return NextResponse.json<AuditResponseDTO>(payload);
}

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleAuditGet(request));
}

export async function POST() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is append-only and cannot be created via API", 405);
}

export async function PUT() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is append-only and cannot be updated", 405);
}

export async function PATCH() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is append-only and cannot be updated", 405);
}

export async function DELETE() {
  return createErrorResponse("METHOD_NOT_ALLOWED", "Audit log is append-only and cannot be deleted", 405);
}
