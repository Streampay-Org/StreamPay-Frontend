import { NextResponse } from "next/server";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, settleStore } from "@/app/lib/idempotency";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { executeStreamAction } from "@/app/lib/stream-executor";

type Context = { params: Promise<{ id: string }> };

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function errorResponse(code: string, message: string, status: number) {
  return createErrorResponse(code, message, status);
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // IDEMPOTENCY: Settle is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the settlement
  return withIdempotency(request, "settle", settleStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      const actorAddress = getHeader(request, "Actor-Wallet-Address");
      const policyResult = actorAddress
        ? checkStreamOrgPolicy(id, actorAddress, "settle")
        : null;
      if (policyResult) {
        if (!policyResult.allowed) {
          return errorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
        }
        if (policyResult.requiresApproval) {
          return errorResponse(
            "APPROVAL_REQUIRED",
            "This action requires multi-sig approval. Please initiate an approval request.",
            409
          );
        }
      }

      const execResult = await executeStreamAction(id, "settle", {
        actor: actorAddress,
        request,
      });

      if (!execResult.ok) {
        return errorResponse(execResult.code, execResult.error, execResult.status);
      }

      return NextResponse.json({ data: execResult.data });
    });
  });
}
