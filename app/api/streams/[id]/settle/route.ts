import { NextResponse } from "next/server";
import { withIdempotency, settleStore } from "@/app/lib/idempotency";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { getStellarSettlementClient } from "@/app/lib/stellar";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { enforceStreamRbac, resolveActorAddress } from "@/app/lib/org-policy";
import { settleStreamById } from "@/app/lib/settle-stream";

type Context = { params: Promise<{ id: string }> };

function createErrorResponse(code: string, message: string, status: number, legacyCode?: string) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, ...(legacyCode ? { legacy_code: legacyCode } : {}), message, request_id: context?.request_id } },
    { status },
  );
}

function errorResponse(code: string, message: string, status: number, legacyCode?: string) {
  return createErrorResponse(code, message, status, legacyCode);
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

/**
 * POST /api/streams/:id/settle
 *
 * Settles an active or paused stream.
 *
 * Actor resolution order:
 * 1. Verified JWT `sub` claim (Bearer token).
 * 2. `Actor-Wallet-Address` header (fallback only when STREAMPAY_ALLOW_ACTOR_HEADER=true).
 * If both are present and differ, returns 403 ACTOR_MISMATCH.
 *
 * RBAC ordering:
 * Runs after 404 stream existence check and before state transition validation
 * and chain call, inside the stream lock.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
)
{
  const { id } = await params;

  // Rate limit guard — applied before auth/RBAC so throttled callers cannot
  // probe stream ownership by burning through the write bucket. Matches pause.
  const rateCheck = await streamsRateLimit(request, "POST", `/api/streams/${id}/settle`);
  if (!rateCheck.allowed) {
    return rateCheck.response;
  }

  let actorAddress: string | null = null;
  try {
    actorAddress = resolveActorAddress(request);
  } catch {
    actorAddress = getHeader(request, "Actor-Wallet-Address");
  }
  // IDEMPOTENCY: Settle is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the settlement
  return withIdempotency(request, "settle", settleStore, async () => {
    const outcome = await settleStreamById({
      streamId: id,
      request,
      actorAddress,
      // RBAC: evaluated inside the lock, immediately after 404 and before state guard or chain call.
      beforeTransition: () => enforceStreamRbac(request, id, "settle"),
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not_found":
          return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
        case "guard_rejected":
          return outcome.guardResult as NextResponse;
        case "invalid_state":
          return errorResponse(outcome.code, outcome.error, 409, outcome.legacyCode);
        case "settlement_failed":
          return errorResponse("SETTLEMENT_FAILED", "Failed to settle stream on Stellar/Soroban", 502);
      }
    }

    if (outcome.idempotent) {
      return NextResponse.json({ data: outcome.stream });
    }

    return NextResponse.json({ data: { ...outcome.stream, settlement: outcome.settlement } });
  }, { resourceId: id, actorId: actorAddress ?? undefined });
}