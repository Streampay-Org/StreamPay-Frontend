import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  db,
  idempotencyToken,
  setIdempotency,
  withLock,
} from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";

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

  const idempotencyKey = getHeader(request, "Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken(`streams.start.${id}`, idempotencyKey)
    : null;

  const fingerprint = computeFingerprint("POST", `/api/streams/${id}/start`, null);

  if (token) {
    const cached = checkIdempotency(db.idempotency, token, fingerprint);
    if (cached) {
      if (!cached.ok) {
        return NextResponse.json(
          { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request." } },
          { status: 409 },
        );
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  return withLock(id, async () => {
    if (token) {
      const cached = checkIdempotency(db.idempotency, token, fingerprint);
      if (cached) {
        if (!cached.ok) {
          return NextResponse.json(
            { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request." } },
            { status: 409 },
          );
        }
        return NextResponse.json(cached.body, { status: cached.status });
      }
    }

    const stream = db.streams.get(id);
    if (!stream) {
      return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
    }

    const actorAddress = getHeader(request, "Actor-Wallet-Address");
    // Use "start" for initial activation; "resume" maps to "start" in the org policy
    const orgAction = "start" as const;
    const policyResult = actorAddress
      ? checkStreamOrgPolicy(id, actorAddress, orgAction)
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

    const execResult = await executeStreamAction(id, "start", {
      actor: actorAddress,
      request,
    });

    if (!execResult.ok) {
      return createErrorResponse(execResult.code, execResult.error, execResult.status);
    }

    appendStreamHistoryEvent({
      streamId: id,
      type: isResume ? "resumed" : "started",
      fromStatus: stream.status,
      toStatus: "active",
      at: updatedStream.updatedAt,
      actorWallet: actorAddress,
    });

    const payload = { data: updatedStream };
    if (token) {
      setIdempotency(db.idempotency, token, fingerprint, 200, payload);
    }

    return NextResponse.json(payload);
  });
}
