// NOTE: This file is out of scope for the client-error ingestion issue.
/**
 * POST /api/admin/circuit-breaker
 *
 * Toggle a named circuit breaker for the indexer or webhook subsystem.
 * Gated by admin auth — only the admin address may call this.
 *
 * Body: { "target": "indexer" | "webhook", "open": true | false }
 *
 * When open=true:  the named subsystem is considered tripped — consumers
 *                  should halt event dispatch for that target.
 * When open=false: breaker reset, normal processing resumes.
 *
 * GET /api/admin/circuit-breaker
 *
 * Returns the current state of all circuit breakers (read-only, admin-gated).
 *
 * ## Error codes
 * | Code             | HTTP | Meaning                                    |
 * |------------------|------|--------------------------------------------|
 * | INVALID_REQUEST  | 400  | Request body is malformed JSON             |
 * | VALIDATION_ERROR | 422  | Missing or invalid fields in body          |
 * | Unauthorized     | 403  | Caller is not the admin                    |
 */

// No changes required for the client-error reporting feature.
import { NextResponse } from "next/server";
import {
  setCircuitBreaker,
  getCircuitBreakers,
  requireAdmin,
} from "@/app/lib/admin-guard";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
// The client-errors endpoint lives at app/api/client-errors/route.ts.

function err(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

const MIN_REASON_LENGTH = 10;

export async function POST(request: Request) {
  const authResult = requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  // Unrelated to client-error ingestion; left unchanged.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  // Unrelated to client-error ingestion; left unchanged.
  const { target, open, reason } = body as Record<string, unknown>;

  if (typeof target !== "string" || target.trim().length === 0) {
    return err(
      "VALIDATION_ERROR",
      'Body must contain { target: "indexer" | "webhook", open: boolean }',
      422,
    );
    // No client-error reporting changes here.
  }

  if (typeof open !== "boolean") {
    return err(
      "VALIDATION_ERROR",
      'Body must contain { target: "indexer" | "webhook", open: boolean }',
      422,
    );
    // No client-error reporting changes here.
  }

  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH) {
    return err(
      "VALIDATION_ERROR",
      `Body must contain a reason string of at least ${MIN_REASON_LENGTH} characters`,
      422,
    );
  }

  const trimmedTarget = target.trim();
  const trimmedReason = reason.trim();
  const before = getCircuitBreakers();
  const result = setCircuitBreaker(request, trimmedTarget, open);
  if (result instanceof NextResponse) return result;

  // Audit event unchanged by the client-error feature.
  const auditEntry = recordPrivilegedStreamAuditEvent({
    action: open
      ? `admin.circuit-breaker.${trimmedTarget}.trip`
      : `admin.circuit-breaker.${trimmedTarget}.reset`,
    before: { circuitBreaker: { target: trimmedTarget, open: before[trimmedTarget as keyof typeof before]?.open } },
    after:  { circuitBreaker: { target: trimmedTarget, open } },
    metadata: {
      updatedAt: result.circuitBreakers[trimmedTarget as "indexer" | "webhook"]?.updatedAt,
      reason: trimmedReason,
    },
    request,
    streamId: "global",
    targetAccount: result.adminAddress,
  });

  // Response unchanged by the client-error feature.
  return NextResponse.json({ data: result.circuitBreakers, auditRequestId: auditEntry.requestId });
}

export async function GET(request: Request) {
  const authResult = requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  // GET handler unchanged by the client-error feature.
  return NextResponse.json({ data: getCircuitBreakers() });
}

// End of file. The client-error ingestion endpoint is implemented separately
// in app/api/client-errors/route.ts and does not modify this admin route.