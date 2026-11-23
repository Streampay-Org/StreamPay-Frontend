import { db, withLock } from "@/app/lib/db";
import { validateAmendStatus } from "@/app/lib/state-machine";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { getCorrelationContext } from "@/app/lib/logger";
import type { AmendApprovalPayload } from "@/app/lib/org-types";
import type { Stream } from "@/app/types/openapi";

const RATE_PATTERN = /^\s*([+-]?\d+(?:\.\d+)?)(?:\s+[A-Za-z0-9/._-]+)?\s*$/;

export function parsePositiveRate(rate: string): { ok: true; value: number } | { ok: false; message: string } {
  const match = RATE_PATTERN.exec(rate);
  if (!match) {
    return { ok: false, message: "Rate must be a positive number." };
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return { ok: false, message: "Rate must be greater than 0." };
  }
  return { ok: true, value: numeric };
}

export type ApplyAmendResult =
  | { ok: true; stream: Stream }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_state"; code: "ILLEGAL_TRANSITION"; error: string }
  | { ok: false; reason: "validation_error"; field: string; message: string };

export interface ApplyAmendParams {
  streamId: string;
  payload: AmendApprovalPayload;
  actorAddress?: string | null;
  request?: Request;
  now?: Date;
}

/**
 * Applies a validated stream amendment inside the per-stream lock.
 * Shared by POST /api/streams/[id]/amend and the approval threshold execution path.
 */
export async function applyStreamAmendment({
  streamId,
  payload,
  actorAddress,
  request,
  now,
}: ApplyAmendParams): Promise<ApplyAmendResult> {
  return withLock(streamId, async () => {
    const stream = db.streams.get(streamId);
    if (!stream) {
      return { ok: false, reason: "not_found" };
    }

    const guard = validateAmendStatus(stream.status);
    if (!guard.ok) {
      return {
        ok: false,
        reason: "invalid_state",
        code: guard.code,
        error: guard.error,
      };
    }

    const nowDate = now ?? new Date();
    const nowMs = nowDate.getTime();
    const nowIso = nowDate.toISOString();

    if (payload.rate !== undefined) {
      const rateCheck = parsePositiveRate(payload.rate);
      if (!rateCheck.ok) {
        return {
          ok: false,
          reason: "validation_error",
          field: "rate",
          message: rateCheck.message,
        };
      }
    }

    if (payload.endsAt !== undefined) {
      const endsAtMs = Date.parse(payload.endsAt);
      if (!Number.isFinite(endsAtMs)) {
        return {
          ok: false,
          reason: "validation_error",
          field: "endsAt",
          message: "endsAt must be a valid ISO-8601 timestamp.",
        };
      }
      if (endsAtMs <= nowMs) {
        return {
          ok: false,
          reason: "validation_error",
          field: "endsAt",
          message: "endsAt must be in the future.",
        };
      }
      if (stream.startTime) {
        const startMs = Date.parse(stream.startTime);
        if (Number.isFinite(startMs) && endsAtMs <= startMs) {
          return {
            ok: false,
            reason: "validation_error",
            field: "endsAt",
            message: "endsAt must be after startedAt.",
          };
        }
      }
    }

    const before = structuredClone(stream);
    const updated: Stream = {
      ...stream,
      ...(payload.rate !== undefined ? { rate: payload.rate } : {}),
      ...(payload.endsAt !== undefined ? { endTime: payload.endsAt } : {}),
      updatedAt: nowIso,
    };

    db.streams.set(streamId, updated);

    appendStreamHistoryEvent({
      streamId,
      type: "amended",
      fromStatus: stream.status,
      toStatus: updated.status,
      at: nowIso,
      actorWallet: actorAddress ?? undefined,
    });

    publishStreamChange({
      action: "amend",
      actor: actorAddress ?? undefined,
      after: updated,
      before,
      correlationId: getCorrelationContext()?.correlation_id,
    });

    if (request) {
      recordPrivilegedStreamAuditEvent({
        action: "stream.amend",
        after: updated as any,
        before: before as any,
        request,
        streamId,
        targetAccount: updated.recipient,
      });
    }

    return { ok: true, stream: updated };
  });
}
