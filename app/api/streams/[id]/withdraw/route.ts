import { NextResponse } from "next/server";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, withdrawStore } from "@/app/lib/idempotency";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { enforceStreamRbac, resolveActorAddress } from "@/app/lib/org-policy";
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

/**
 * POST /api/streams/:id/withdraw
 *
 * Withdraws funds from an ended stream.
 *
 * Actor resolution order:
 * 1. Verified JWT `sub` claim (Bearer token).
 * 2. `Actor-Wallet-Address` header (fallback only when STREAMPAY_ALLOW_ACTOR_HEADER=true).
 * If both are present and differ, returns 403 ACTOR_MISMATCH.
 *
 * RBAC ordering:
 * Runs after 404 stream existence check and before state transition validation
 * and ledger confirmation evaluation, inside the stream lock.
 */
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

  let actorAddress: string | null = null;
  try {
    actorAddress = resolveActorAddress(request);
  } catch {
    actorAddress = getHeader(request, "Actor-Wallet-Address");
  }

  // IDEMPOTENCY: Withdraw is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the withdrawal
  return withIdempotency(withIdempotencyReadableBody(request), "withdraw", withdrawStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      // RBAC: evaluated inside the lock, immediately after 404 and before state guard or ledger check.
      const rbacError = enforceStreamRbac(request, id, "withdraw");
      if (rbacError) return rbacError;

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
        actorWallet: actorAddress ?? undefined,
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
