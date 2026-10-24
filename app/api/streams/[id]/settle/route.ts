import { NextResponse } from "next/server";
import { db, withLock } from "@/app/lib/db";
import { withIdempotency, settleStore } from "@/app/lib/idempotency";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { nextActionFor, transition } from "@/app/lib/state-machine";
import { enforceStreamRbac, resolveActorAddress } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { getStellarSettlementClient, type SettlementReceipt } from "@/app/lib/stellar";
import { toWebhookEvent, webhookOutboxStore } from "@/app/lib/webhook-outbox";
import { runWithTimeout } from "@/app/lib/with-timeout";

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
) {
  const { id } = await params;
  let actorAddress: string | null = null;
  try {
    actorAddress = resolveActorAddress(request);
  } catch {
    actorAddress = getHeader(request, "Actor-Wallet-Address");
  }
  // IDEMPOTENCY: Settle is non-idempotent by nature — this wrapper ensures retries return the original response without re-executing the settlement
  return withIdempotency(request, "settle", settleStore, async () => {
    return withLock(id, async () => {
      const stream = db.streams.get(id);
      if (!stream) {
        return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
      }

      // RBAC: evaluated inside the lock, immediately after 404 and before state guard or chain call.
      const rbacError = enforceStreamRbac(request, id, "settle");
      if (rbacError) return rbacError;

      const result = transition(stream.status, "settle");
      if (!result.ok) {
        return errorResponse(result.code, result.error, 409, "INVALID_STREAM_STATE");
      }

      if (result.nextStatus === stream.status) {
        return NextResponse.json({ data: stream });
      }

      const before = structuredClone(stream);

      let settlement: SettlementReceipt;
      try {
        settlement = await runWithTimeout(SETTLEMENT_TIMEOUT_MS, async () => {
          return await getStellarSettlementClient().settleStream({ streamId: id });
        });
      } catch (err: any) {
        const errorClass = err?.constructor?.name ?? (err instanceof Error ? err.name : "Error");
        logger.error("Settlement failed on Stellar/Soroban", {
          errorClass,
          correlationId: getCorrelationContext()?.correlation_id,
        });
        return errorResponse(
          "SETTLEMENT_FAILED",
          "Failed to settle stream on Stellar/Soroban",
          502,
          { retryable: true }
        );
      }

      const now = new Date().toISOString();
      const updatedStream = {
        ...stream,
        nextAction: nextActionFor(result.nextStatus),
        settlementTxHash: txHash,
        status: result.nextStatus,
        updatedAt: now,
        withdrawal: {
          attempts: 0,
          lastCheckedAt: now,
          requestedAt: now,
          settlementTxHash: settlement.txHash,
          state: "pending" as const,
        },
      };
      db.streams.set(id, updatedStream);

      try {
        const settlement = await getStellarSettlementClient().settleStream({ streamId: id });

        db.streams.set(id, updatedStream);

        appendStreamHistoryEvent({
          streamId: id,
          type: "settled",
          fromStatus: stream.status,
          toStatus: "ended",
          at: updatedStream.updatedAt,
          actorWallet: actorAddress ?? undefined,
          txHash: settlement.txHash,
        });

      db.streams.set(id, updatedStream);

      appendStreamHistoryEvent({
        streamId: id,
        type: "settled",
        fromStatus: stream.status,
        toStatus: "ended",
        at: updatedStream.updatedAt,
        actorWallet: getHeader(request, "Actor-Wallet-Address"),
        txHash: settlement.txHash,
      });

      recordPrivilegedStreamAuditEvent({
        action: "stream.settle",
        after: updatedStream as any,
        before: before as any,
        metadata: {
          settlementTxHash: settlement.txHash,
        },
        request,
        streamId: id,
        targetAccount: updatedStream.recipient,
      });

      // Enqueue lifecycle webhook after commit, only if the stream has a webhook URL.
      // Deterministic event id prevents double-enqueue on retries of the same commit.
      const webhookUrl = (updatedStream as typeof updatedStream & { webhook_url?: string }).webhook_url;
      if (webhookUrl) {
        const event = toWebhookEvent(before as any, updatedStream as any, "settle");
        if (event) {
          webhookOutboxStore.enqueueStreamLifecycleEventIdempotent(
            { ...updatedStream, webhook_url: webhookUrl },
            event,
            {
              stream_id: id,
              status: updatedStream.status,
              previous_status: before.status,
              action: "settle",
              occurred_at: now,
              token: updatedStream.token,
              settlement_tx_hash: settlement.txHash,
            },
            now,
          );
        }
      }

      publishStreamChange({
        action: "settle",
        actor: actorAddress ?? undefined,
        after: updatedStream,
        before,
        correlationId: getCorrelationContext()?.correlation_id,
      });

      const payload = { data: { ...updatedStream, settlement } };

      logger.info("Stream settled successfully", {
        streamId: id,
        action: "settle",
        status: "success",
      });

      return NextResponse.json(payload);
    });
  }, { resourceId: id, actorId: actorAddress ?? undefined });
}
