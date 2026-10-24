import { NextResponse } from "next/server";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, withdrawStore } from "@/app/lib/idempotency";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import {
  checkStreamOrgPolicy,
  isActorHeaderAllowed,
  requireStreamActor,
} from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { generateRequestId } from "@/lib/requestId";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { evaluateWithdrawalState } from "@/app/lib/withdraw-finality";
import { computeWithdraw, resolveEscrowState } from "@/app/lib/recipient-withdraw";
import type { WithdrawErrorCode } from "@/app/lib/recipient-withdraw";
import { maybeFeeBump } from "@/lib/feeBump";

type Context = { params: Promise<{ id: string }> };

const I128_MAX = (1n << 127n) - 1n;

const WITHDRAW_ERROR_STATUS: Record<WithdrawErrorCode, number> = {
  RECIPIENT_AUTH_REQUIRED: 403,
  ZERO_AMOUNT: 422,
  OVER_WITHDRAW: 422,
  INVALID_ESCROW_STATE: 422,
  NO_WITHDRAWABLE_BALANCE: 409,
  INVALID_STREAM_STATE: 409,
};

function createErrorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? generateRequestId();
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

/**
 * Resolve the caller identity for a withdrawal: the verified JWT `sub` wins;
 * the `Actor-Wallet-Address` header is only a fallback when
 * STREAMPAY_ALLOW_ACTOR_HEADER permits it. A spoofed header can therefore
 * never override a verified identity.
 */
function resolveCallerAddress(request: Request): string | null {
  const jwtAddress = tryAuthenticateRequest(request)?.walletAddress ?? null;
  if (jwtAddress) return jwtAddress;
  const header = getHeader(request, "Actor-Wallet-Address")?.trim() || null;
  return header && isActorHeaderAllowed() ? header : null;
}

/**
 * Only the recipient, or an org member whose role permits `withdraw` on an
 * org-owned stream, may withdraw. Returns an error response when denied.
 */
function authorizeWithdrawCaller(
  streamId: string,
  callerAddress: string,
  recipient: string,
): NextResponse | null {
  if (callerAddress === recipient) return null;

  const policyResult = checkStreamOrgPolicy(streamId, callerAddress, "withdraw");
  if (!policyResult) {
    return createErrorResponse(
      "RECIPIENT_AUTH_REQUIRED",
      "Only the stream recipient or an authorized org member may withdraw.",
      403,
    );
  }
  if (!policyResult.allowed) {
    if (policyResult.code === "ROLE_INSUFFICIENT") {
      return createErrorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
    }
    return createErrorResponse(
      "RECIPIENT_AUTH_REQUIRED",
      "Only the stream recipient or an authorized org member may withdraw.",
      403,
    );
  }
  if (policyResult.requiresApproval) {
    return createErrorResponse(
      "APPROVAL_REQUIRED",
      "This action requires multi-sig approval. Please initiate an approval request.",
      409,
    );
  }
  return null;
}

/** True when the stream is managed by an existing organisation. */
function isOrgOwnedStream(streamId: string): boolean {
  const orgId = orgDb.streamOwnership.get(streamId);
  return Boolean(orgId && orgDb.orgs.get(orgId));
}

function validationError(message: string) {
  return createErrorResponse("VALIDATION_ERROR", message, 422);
}

async function readJsonBody(request: Request): Promise<
  { ok: true; body: unknown } | { ok: false; message: string }
> {
  let text: string | undefined;

  if (typeof (request as any).text === "function") {
    try {
      text = await request.text();
    } catch {
      return { ok: false, message: "Unable to read request body." };
    }
  } else if (typeof (request as any).json === "function") {
    try {
      return { ok: true, body: await request.json() };
    } catch {
      return { ok: false, message: "Request body must be valid JSON." };
    }
  }

  if (!text || text.trim().length === 0) {
    return { ok: true, body: null };
  }

  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, message: "Request body must be valid JSON." };
  }
}

async function parseRequestedAmount(
  request: Request,
): Promise<
  { ok: true; requestedAmount?: bigint } | { ok: false; message: string }
> {
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody;

  const body = parsedBody.body;
  if (body === null || body === undefined) {
    return { ok: true };
  }

  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const value = (body as Record<string, unknown>).amount;
  if (value === undefined) {
    return { ok: true };
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return {
      ok: false,
      message: "amount must be a non-negative raw i128 integer string.",
    };
  }

  let requestedAmount: bigint;
  try {
    requestedAmount = BigInt(value);
  } catch {
    return {
      ok: false,
      message: "amount must be a non-negative raw i128 integer string.",
    };
  }

  if (requestedAmount > I128_MAX) {
    return { ok: false, message: "amount exceeds the maximum i128 value." };
  }

  return { ok: true, requestedAmount };
}

function withIdempotencyReadableBody(request: Request): Request {
  try {
    if (typeof (request as any).clone === "function") {
      return request.clone();
    }
  } catch {
    return request;
  }
  return request;
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

  // Org-owned streams follow the shared RBAC actor contract: a missing
  // identity is 403 ACTOR_REQUIRED and a JWT/header conflict is 403
  // ACTOR_MISMATCH (both with a request_id in the envelope).
  if (isOrgOwnedStream(id)) {
    const actorResult = requireStreamActor(request);
    if (actorResult instanceof NextResponse) return actorResult;
  }

  const resolvedCaller = resolveCallerAddress(request);
  if (!resolvedCaller) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "A verified caller identity is required to withdraw from a stream.",
      401,
    );
  }
  const callerAddress: string = resolvedCaller;

  // Authorise before consulting the idempotency store so an unauthorised
  // caller is always told 403, never offered another caller's replay.
  const existingStream = db.streams.get(id);
  if (existingStream) {
    const authError = authorizeWithdrawCaller(id, callerAddress, existingStream.recipient);
    if (authError) return authError;
  }

  // IDEMPOTENCY: Withdraw is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the withdrawal
  return withIdempotency(withIdempotencyReadableBody(request), "withdraw", withdrawStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      const authError = authorizeWithdrawCaller(id, callerAddress, stream.recipient);
      if (authError) return authError;

      if (stream.status === "withdrawn") {
        const payload = { data: stream, withdrawal: stream.withdrawal };
        return NextResponse.json(payload);
      }

      if (stream.status !== "ended") {
        return createErrorResponse(
          "INVALID_STREAM_STATE",
          "Only ended streams can be withdrawn from",
          409,
        );
      }

      const parsedAmount = await parseRequestedAmount(request);
      if (!parsedAmount.ok) {
        return validationError(parsedAmount.message);
      }

      const now = new Date();
      const escrowResult = resolveEscrowState(stream, now);
      if (!escrowResult.ok) {
        return createErrorResponse(
          "INVALID_ESCROW_STATE",
          "Escrow state for this stream is unknown; refusing to compute a withdrawal.",
          WITHDRAW_ERROR_STATUS.INVALID_ESCROW_STATE,
        );
      }
      const escrow = escrowResult.value;
      const outcome = computeWithdraw(stream, {
        totalAmount: escrow.total,
        releasedAmount: escrow.released,
        vestedAmount: escrow.vested,
        requestedAmount: parsedAmount.requestedAmount,
        token: stream.token ?? "XLM",
        recipientAddress: stream.recipient,
        callerAddress: stream.recipient,
        now,
      });

      if (!outcome.ok) {
        return createErrorResponse(
          outcome.code,
          outcome.message,
          WITHDRAW_ERROR_STATUS[outcome.code],
        );
      }

      const before = structuredClone(stream);
      const updatedStream = {
        ...stream,
        releasedAmount: outcome.result.newReleasedAmount.toString(),
        updatedAt: now.toISOString(),
      };
      db.streams.set(id, updatedStream);

      let evaluationResult = await evaluateWithdrawalState(updatedStream, now, fetch);

      // ── Fee-bump: if the withdrawal failed due to insufficient fees,
      //    automatically attempt a fee-bump resubmission ─────────────────
      const { result: finalResult, feeBump } = await maybeFeeBump(
        { stream: evaluationResult.stream, alert: evaluationResult.alert },
        fetch,
      );

      if (feeBump.bumped) {
        logger.info("Fee-bump transaction submitted successfully", {
          streamId: id,
          newTxHash: feeBump.newTxHash,
        });
      } else if (feeBump.error) {
        logger.warn("Fee-bump attempt failed", {
          streamId: id,
          error: feeBump.error,
        });
      }

      const updated = finalResult.stream;
      db.streams.set(id, updated);

      appendStreamHistoryEvent({
        streamId: id,
        type: "withdrawn",
        fromStatus: "ended",
        toStatus: updated.status,
        at: new Date().toISOString(),
        actorWallet: callerAddress,
      });
      publishStreamChange({
        action: "withdraw",
        actor: callerAddress,
        after: updated,
        before,
        correlationId: getCorrelationContext()?.correlation_id,
      });

      const payload = {
        alert: finalResult.alert,
        data: updated,
        withdrawal: updated.withdrawal,
        ...(feeBump.bumped ? { feeBump: { bumped: true, newTxHash: feeBump.newTxHash } } : {}),
      };

      recordPrivilegedStreamAuditEvent({
        action: "stream.withdraw",
        after: updated as any,
        before: before as any,
        metadata: {
          amountPaidOut: outcome.result.amountPaidOut.toString(),
          resultingStatus: updated.status,
          withdrawalState: updated.withdrawal?.state ?? null,
        },
        request,
        streamId: id,
        targetAccount: updated.recipient,
      });

      logger.info("Stream withdrawn successfully", {
        streamId: id,
        action: "withdraw",
        status: "success",
      });

      return NextResponse.json(payload);
    });
  }, { resourceId: id, actorId: callerAddress });
}
