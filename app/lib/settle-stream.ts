import { db, withLock } from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { nextActionFor, transition } from "@/app/lib/state-machine";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { getStellarSettlementClient, type SettlementReceipt } from "@/app/lib/stellar";
import { addToOutbox } from "@/app/lib/webhook-outbox";
import { toWebhookEvent, buildStreamWebhookPayload } from "@/app/lib/stream-webhook-events";
import type { Stream } from "@/app/types/openapi";

export type SettleStreamOptions = {
  streamId: string;
  request: Request;
  actorAddress?: string | null;
  /**
   * Optional guard evaluated inside the stream lock, immediately after the 404
   * existence check and before state transition validation or chain calls.
   * Returning a non-null value short-circuits settlement and surfaces it to the caller.
   */
  beforeTransition?: () => unknown;
};

export type SettleStreamResult =
  | {
      ok: true;
      idempotent: true;
      stream: Stream;
    }
  | {
      ok: true;
      idempotent: false;
      stream: Stream;
      settlement: SettlementReceipt;
    }
  | {
      ok: false;
      reason: "not_found";
    }
  | {
      ok: false;
      reason: "guard_rejected";
      guardResult: unknown;
    }
  | {
      ok: false;
      reason: "invalid_state";
      code: string;
      error: string;
      legacyCode: "INVALID_STREAM_STATE";
    }
  | {
      ok: false;
      reason: "settlement_failed";
      error: unknown;
    };

/**
 * Executes the core settlement workflow for a single stream under `withLock`:
 * existence check -> optional guard (e.g. RBAC) -> state transition ->
 * Stellar/Soroban settlement call -> DB update -> history, audit, webhook outbox,
 * and live stream change publication.
 */
export async function settleStreamById(options: SettleStreamOptions): Promise<SettleStreamResult> {
  const { streamId: id, request, actorAddress = null, beforeTransition } = options;

  return withLock(id, async () => {
    const stream = db.streams.get(id) as Stream | undefined;
    if (!stream) {
      return { ok: false, reason: "not_found" };
    }

    if (beforeTransition) {
      const guardResult = beforeTransition();
      if (guardResult) {
        return { ok: false, reason: "guard_rejected", guardResult };
      }
    }

    const result = transition(stream.status, "settle");
    if (!result.ok) {
      return {
        ok: false,
        reason: "invalid_state",
        code: result.code,
        error: result.error,
        legacyCode: "INVALID_STREAM_STATE",
      };
    }

    if (result.nextStatus === stream.status) {
      return { ok: true, idempotent: true, stream };
    }

    const before = structuredClone(stream);
    const txHash = `fake-tx-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const updatedStream: Stream = {
      ...stream,
      nextAction: nextActionFor(result.nextStatus),
      settlementTxHash: txHash,
      status: result.nextStatus,
      updatedAt: now,
      withdrawal: {
        attempts: 0,
        lastCheckedAt: now,
        requestedAt: now,
        settlementTxHash: txHash,
        state: "pending" as const,
      },
    };

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

      recordPrivilegedStreamAuditEvent({
        action: "stream.settle",
        after: updatedStream as unknown as Record<string, unknown>,
        before: before as unknown as Record<string, unknown>,
        metadata: {
          settlementTxHash: settlement.txHash,
        },
        request,
        streamId: id,
        targetAccount: updatedStream.recipient,
      });

      // Enqueue lifecycle webhook after commit, only if the stream has a webhook URL.
      // Deterministic event id prevents double-enqueue on retries of the same commit.
      if (updatedStream.webhook_url) {
        const eventType = toWebhookEvent(before as any, updatedStream as any, "settle");
        addToOutbox({
          eventId: `evt_${id}_settle_${updatedStream.updatedAt}`,
          eventType,
          streamId: id,
          url: updatedStream.webhook_url,
          payload: buildStreamWebhookPayload({
            eventType,
            streamId: id,
            action: "settle",
            before: before as any,
            after: updatedStream as any,
            occurredAt: updatedStream.updatedAt,
          }),
        });
      }

      publishStreamChange({
        action: "settle",
        actor: actorAddress ?? undefined,
        after: updatedStream,
        before,
        correlationId: getCorrelationContext()?.correlation_id,
      });

      logger.info("Stream settled successfully", {
        streamId: id,
        action: "settle",
        status: "success",
      });

      return {
        ok: true,
        idempotent: false,
        stream: updatedStream,
        settlement,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "settlement_failed",
        error,
      };
    }
  });
}
