import { NextResponse } from "next/server";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, withdrawStore } from "@/app/lib/idempotency";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { executeStreamAction } from "@/app/lib/stream-executor";

type Context = { params: Promise<{ id: string }> };

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Rate limit guard
  const rateCheck = await streamsRateLimit(request, "POST", `/api/streams/${id}/withdraw`);
  if (!rateCheck.allowed) {
    return rateCheck.response;
  }

  const actorAddress = getHeader(request, "Actor-Wallet-Address");

  // IDEMPOTENCY: Withdraw is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the withdrawal
  return withIdempotency(request, "withdraw", withdrawStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      const policyResult = actorAddress
        ? checkStreamOrgPolicy(id, actorAddress, "withdraw")
        : null;
      if (policyResult) {
        if (!policyResult.allowed) {
          return createErrorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
        }
        if (policyResult.requiresApproval) {
          return createErrorResponse(
            "APPROVAL_REQUIRED",
            "This action requires multi-sig approval. Please initiate an approval request.",
            409
          );
        }
      }

      const execResult = await executeStreamAction(id, "withdraw", {
        actor: actorAddress,
        request,
      });

      if (!execResult.ok) {
        return createErrorResponse(execResult.code, execResult.error, execResult.status);
      }

      const payload = {
        data: execResult.data,
        ...(execResult.extra || {}),
      };

      return NextResponse.json(payload);
    });
  });
}
