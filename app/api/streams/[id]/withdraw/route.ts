import { NextResponse } from "next/server";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, withdrawStore } from "@/app/lib/idempotency";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { checkStreamOrgPolicy } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { evaluateWithdrawalState } from "@/app/lib/withdraw-finality";
import { computeWithdraw, resolveEscrowState } from "@/app/lib/recipient-withdraw";
import type { WithdrawErrorCode } from "@/app/lib/recipient-withdraw";
import { tryAuthenticateRequest } from "@/app/lib/auth";
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
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

function resolveCallerAddress(request: Request): string | null {
  const actor = tryAuthenticateRequest(request);
  if (actor?.walletAddress) return actor.walletAddress;

  const header = getHeader(request, "Actor-Wallet-Address");
  return header?.trim() || null;
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

  const callerAddress = resolveCallerAddress(request);
  if (!callerAddress) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "A verified caller identity is required to withdraw from a stream.",
      401,
    );
  }

  // IDEMPOTENCY: Withdraw is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the withdrawal
  return withIdempotency(withIdempotencyReadableBody(request), "withdraw", withdrawStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      if (callerAddress !== stream.recipient) {
        const policyResult = checkStreamOrgPolicy(id, callerAddress, "withdraw");
        if (!policyResult) {
          return createErrorResponse(
            "RECIPIENT_AUTH_REQUIRED",
            "Only the stream recipient or an authorized org member may withdraw.",
            403,
          );
        }
        if (!policyResult.allowed) {
          if (policyResult.code === "ROLE_INSUFFICIENT") {
            return createErrorResponse(
              policyResult.code,
              policyResult.message,
              policyResult.httpStatus,
            );
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
      }

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
      const escrow = resolveEscrowState(stream, now);
      const outcome = computeWithdraw(stream, {
        totalAmount: escrow.totalAmount,
        releasedAmount: escrow.releasedAmount,
        vestedAmount:
          stream.vestedAmount !== undefined
            ? BigInt(stream.vestedAmount)
            : escrow.vestedAmount,
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
        actorWallet: actorAddress,
      });
      publishStreamChange({
        action: "withdraw",
        actor: actorAddress ?? undefined,
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
  }, { resourceId: id, actorId: actorAddress ?? undefined });
}
