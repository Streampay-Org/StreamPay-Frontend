// Pause route: records `pausedAt`; resume (in /start) accumulates `totalPausedMs`.
/**
 * POST /api/streams/:id/pause
 *
 * Pause entrypoint — halts individual stream accrual and records the
 * pause timestamp (`pausedAt`) on the stream record.
 *
 * ## State transition
 *   active → paused
 *
 * ## Fields written on success
 * | Field       | Value                                      |
 * |-------------|--------------------------------------------|
 * | `status`    | `"paused"`                                 |
 * | `nextAction`| `"start"`                                  |
 * | `pausedAt`  | ISO-8601 UTC timestamp of this request.    |
 * | `updatedAt` | ISO-8601 UTC timestamp of this request.    |
 *
 * ## Timing fields (contract parity)
 * The stream record carries `startTime`, `endTime` and `totalPausedMs`
 * (all raw millisecond numbers) which mirror the Soroban contract's
 * `start`, `end` and `total_paused_duration` storage fields. `pausedAt`
 * maps to `paused_at`. Together these drive `vestedAmount` in
 * `app/lib/escrow-state.ts` with bigint-only arithmetic.
 *
 * `pausedAt` is the wall-clock instant accrual freezes. The matching
 * `totalPausedMs` accumulator lives on the stream record and is updated by
 * the /start (resume) route, mirroring `resume` in `src/lib.rs`.
 *
 * `pausedAt` maps to the Soroban contract's `paused_at` storage field on
 * the stream escrow account (GrantFox campaign, issue #pause-entrypoint).
 * The settlement catch-up job uses this value to compute accrued-but-
 * unsettled ticks between `pausedAt` and the subsequent resume.
 *
 * ## Fields cleared on resume
 * `pausedAt` is set to `undefined` when `POST /api/streams/:id/start`
 * successfully resumes the stream from `paused` status.
 *
 * ## Auth
 * Org-owned streams require an `Actor-Wallet-Address` header carrying a
 * wallet address with a role that has `canPause` permission (owner or pauser
 * in the default policy). Individually owned streams skip the RBAC check.
 *
 * ## Idempotency
 * Supply an `Idempotency-Key` header to make the operation safe to retry.
 * The same key on the same stream always returns the same cached response.
 *
 * ## Error codes
 * | Status | Code                    | Reason                                   |
 * |--------|-------------------------|------------------------------------------|
 * | 404    | `STREAM_NOT_FOUND`      | Stream does not exist.                   |
 * | 409    | `ILLEGAL_TRANSITION`     | Pause is not allowed in the current state. |
 * |        | `legacy_code`            | `INVALID_STREAM_STATE` for compatibility. |
 * | 403    | `NOT_ORG_MEMBER`        | Actor is not in the owning org.          |
 * | 403    | `ROLE_INSUFFICIENT`     | Actor's role cannot pause.               |
 * | 409    | `APPROVAL_REQUIRED`     | Org policy requires multi-sig approval.  |
 * | 409    | `IDEMPOTENCY_CONFLICT`  | Key reused with a different request.     |
 */

import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  db,
  idempotencyToken,
  setIdempotency,
  withLock,
} from "@/app/lib/db";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { enforceStreamRbac, resolveActorAddress } from "@/app/lib/org-policy";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { addToOutbox } from "@/app/lib/webhook-outbox";
import { toWebhookEvent } from "@/app/lib/webhook-events";
import { publishStreamChange } from "@/app/lib/stream-publish";

function createErrorResponse(code: string, message: string, status: number, legacyCode?: string) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, ...(legacyCode ? { legacy_code: legacyCode } : {}), message, request_id: context?.request_id } },
    { status },
  );
}

function getHeader(req: Request, name: string): string | null {
  return req.headers?.get?.(name) ?? null;
}

/**
 * POST /api/streams/:id/pause
 *
 * Pauses an active stream.
 *
 * Actor resolution order:
 * 1. Verified JWT `sub` claim (Bearer token).
 * 2. `Actor-Wallet-Address` header (fallback only when STREAMPAY_ALLOW_ACTOR_HEADER=true).
 * If both are present and differ, returns 403 ACTOR_MISMATCH.
 *
 * RBAC ordering:
 * Runs after 404 stream existence check and before state transition validation,
 * inside the stream lock.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Rate limit guard
  const rateCheck = await streamsRateLimit(req, "POST", `/api/streams/${id}/pause`);
  if (!rateCheck.allowed) {
    return rateCheck.response;
  }

  const idempotencyKey = getHeader(req, "Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken(`streams.pause.${id}`, idempotencyKey)
    : null;

  const fingerprint = computeFingerprint("POST", `/api/streams/${id}/pause`, null);

  // Pre-lock idempotency check — avoids acquiring the lock for pure replays.
  if (token) {
    const cached = checkIdempotency(db.idempotency, token, fingerprint);
    if (cached) {
      if (!cached.ok) {
        return NextResponse.json(
          {
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Idempotency key has been used with a different request.",
            },
          },
          { status: 409 },
        );
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  return withLock(id, async () => {
    // Post-lock idempotency check — guards against races between concurrent
    // requests that both passed the pre-lock check simultaneously.
    if (token) {
      const cached = checkIdempotency(db.idempotency, token, fingerprint);
      if (cached) {
        if (!cached.ok) {
          return NextResponse.json(
            {
              error: {
                code: "IDEMPOTENCY_CONFLICT",
                message: "Idempotency key has been used with a different request.",
              },
            },
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

    // ── Org RBAC ──────────────────────────────────────────────────────────
    const rbacError = enforceStreamRbac(req, id, "pause");
    if (rbacError) return rbacError;

    // ── State guard ───────────────────────────────────────────────────────
    const result = transition(stream.status, "pause");
    if (!result.ok) {
      return createErrorResponse(
        result.code,
        result.error,
        409,
        "INVALID_STREAM_STATE",
      );
    }

    if (result.nextStatus === stream.status) {
      return NextResponse.json({ data: stream });
    }

    // ── Mutation ──────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const before = structuredClone(stream);

    const updated = {
      ...stream,
      /**
       * pausedAt: ISO-8601 UTC timestamp recorded the moment this stream
       * enters paused status. Maps to the Soroban contract's `paused_at`
       * storage field. Cleared by the /start endpoint on resume.
       *
       * Note: `totalPausedMs` is NOT modified here. It is accumulated on
       * resume (`now − pausedAt`) so that `vestedAmount` can subtract the
       * total paused duration exactly as `release::vested_amount` does.
       *
       * `startTime` and `endTime` are likewise untouched: the pause only
       * freezes accrual at `pausedAt`; the resume route extends `endTime`
       * by the paused interval and adds it to `totalPausedMs` so that
       * `elapsed = effective_now − start − totalPausedMs` stays exact.
       */
      pausedAt: now,
      nextAction: nextActionFor(result.nextStatus),
      status: result.nextStatus,
      updatedAt: now,
    };

    db.streams.set(id, updated);

    let actorAddress: string | null = null;
    try {
      actorAddress = resolveActorAddress(req);
    } catch {
      actorAddress = getHeader(req, "Actor-Wallet-Address");
    }

    appendStreamHistoryEvent({
      streamId: id,
      type: "paused",
      fromStatus: "active",
      toStatus: "paused",
      at: now,
      actorWallet: actorAddress ?? undefined,
    });
    publishStreamChange({
      action: "pause",
      actor: actorAddress ?? undefined,
      after: updated,
      before,
      correlationId: getCorrelationContext()?.correlation_id,
    });

    // ── Webhook enqueue (post-commit) ─────────────────────────────────────
    // Enqueue only after the store write has committed. The deterministic
    // event id makes retries of the same commit idempotent.
    if (updated.webhook_url) {
      const event = toWebhookEvent(before, updated, "pause");
      if (event) {
        addToOutbox({
          eventId: `evt_${id}_pause_${updated.updatedAt}`,
          streamId: id,
          url: updated.webhook_url,
          type: event.type,
          data: event.data,
          createdAt: now,
        });
      }
    }

    recordPrivilegedStreamAuditEvent({
      action: "stream.pause",
      after: updated as any,
      before: before as any,
      request: req,
      streamId: id,
      targetAccount: updated.recipient,
    });

    const responseBody = { data: updated };

    if (token) {
      setIdempotency(db.idempotency, token, fingerprint, 200, responseBody);
    }

    logger.info("Stream paused successfully", {
      action: "pause",
      pausedAt: now,
      status: "success",
      streamId: id,
    });

    return NextResponse.json(responseBody);
  });
}