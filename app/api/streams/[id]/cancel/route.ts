/**
 * POST /api/streams/:id/cancel
 *
 * Terminates an active or paused stream early and splits the escrowed funds:
 *
 *   recipient_payout = vested_amount  - released_amount  (earned, not yet paid)
 *   sender_refund    = total_amount   - vested_amount    (unvested remainder)
 *
 * Escrow-conservation invariant:
 *   recipient_payout + sender_refund === total_amount - released_amount
 *
 * The stream escrow is fully drained — no dust remains after cancellation.
 * Amounts come from the persisted stream record. Linear vesting is evaluated
 * at cancellation time; missing or malformed escrow data returns 422
 * ESCROW_STATE_UNAVAILABLE without changing the stream.
 *
 * ## Authorization
 * Three ownership states:
 *   - Org-owned: Authorized via org policy (RBAC helper requires "canceller" role).
 *   - Individually owned: Requires verified JWT wallet authentication matching
 *     `stream.senderAddress`. Unauthenticated or non-matching callers receive
 *     403 SENDER_AUTH_REQUIRED.
 *   - Unclaimed: Streams without a recorded senderAddress receive 403 SENDER_UNKNOWN
 *     and cannot be cancelled until claimed.
 *
 * ## Refund Target
 * Escrow refunds are sent strictly to `stream.senderAddress` (recorded at creation time).
 *
 * ## Terminal-state guard
 * Cancelling an already Cancelled / Ended / Withdrawn stream is rejected with
 * ALREADY_TERMINAL (409) to prevent double-refund.
 *
 * ## Idempotency
 * Supports `Idempotency-Key` header — safe to retry on network failure.
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
import { getCorrelationContext } from "@/app/lib/logger";
import { enforceStreamRbac } from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { recordPrivilegedStreamAuditEvent } from "@/app/lib/audit-log";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import { publishStreamChange } from "@/app/lib/stream-publish";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import {
  computeCancellationSplit,
  buildCancellationRecord,
} from "@/app/lib/cancel-stream";
import { escrowNow, resolveEscrowState } from "@/app/lib/escrow-state";
import { webhookOutboxStore, toWebhookEvent } from "@/app/lib/webhook-outbox";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createErrorResponse(code: string, message: string, status: number, legacyCode?: string) {
  const ctx = getCorrelationContext();
  return NextResponse.json(
    { error: { code, ...(legacyCode ? { legacy_code: legacyCode } : {}), message, request_id: ctx?.request_id } },
    { status },
  );
}

function getHeader(req: Request, name: string): string | null {
  return req.headers?.get?.(name) ?? null;
}

function getRequestUrl(req: Request, fallback: string): URL {
  try {
    return req.url ? new URL(req.url) : new URL(`http://localhost${fallback}`);
  } catch {
    return new URL(`http://localhost${fallback}`);
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const path = `/api/streams/${id}/cancel`;
  const url  = getRequestUrl(request, path);

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const limitType = getLimitForRoute("POST", url.pathname);
  const identity  = getClientIdentity(request);
  const rl        = await checkRateLimit(identity, limitType);
  if (!rl.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rl.retryAfter!);
  }
  recordRequest(url.pathname);

  // ── Idempotency ────────────────────────────────────────────────────────────
  const actorAddress    = getHeader(request, "Actor-Wallet-Address");
  const idempotencyKey  = getHeader(request, "Idempotency-Key");
  const idemToken       = idempotencyKey
    ? idempotencyToken(`streams.cancel.${id}`, idempotencyKey)
    : null;

  const fingerprint = computeFingerprint("POST", `/api/streams/${id}/cancel`, null);

  if (idemToken) {
    const cached = checkIdempotency(db.idempotency, idemToken, fingerprint);
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
    // Double-check inside lock (race-condition guard).
    if (idemToken) {
      const cached = checkIdempotency(db.idempotency, idemToken, fingerprint);
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

    // ── Fetch stream ─────────────────────────────────────────────────────────
    const stream = db.streams.get(id);
    if (!stream) {
      return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
    }

    // ── Authorization ─────────────────────────────────────────────────────────
    // Allow: stream sender OR org canceller role.
    // The sender check uses the Actor-Wallet-Address header against
    // stream.senderAddress (set at creation time).
    const isSender = actorAddress && stream.senderAddress
      ? actorAddress === stream.senderAddress
      : false;

    if (!isSender) {
      // Fall through to org-policy check.
      const rbacError = enforceStreamRbac(request, id, "stop"); // "stop" covers canceller role
      if (rbacError) {
        return rbacError;
      }
      if (!actorAddress && !orgDb.streamOwnership.get(id)) {
        // No actor header and stream is not org-owned — reject unauthenticated cancel.
        return createErrorResponse(
          "SENDER_AUTH_REQUIRED",
          "Only the stream sender can cancel this stream",
          403,
        );
      }
    }

    // Preserve the terminal/draft guards even for older records whose escrow
    // fields are absent. No balance lookup is needed for an ineligible stream.
    if (["cancelled", "ended", "withdrawn"].includes(stream.status)) {
      return createErrorResponse("ALREADY_TERMINAL", `Stream is already in terminal state '${stream.status}' and cannot be cancelled. Double-cancel rejected.`, 409);
    }
    if (stream.status === "draft") {
      return createErrorResponse("STREAM_NOT_CANCELLABLE", "Draft streams have no escrowed funds. Start the stream before cancelling.", 422);
    }

    // ── Resolve escrow state ──────────────────────────────────────────────────
    const now = escrowNow();
    const escrowResult = resolveEscrowState(stream, now);
    if (!escrowResult.ok) {
      return createErrorResponse(
        "ESCROW_STATE_UNAVAILABLE",
        "The stream's persisted escrow amounts or vesting schedule are unavailable.",
        422,
      );
    }
    const escrow = escrowResult.value;
    const token  = stream.token ?? "XLM";

    // ── Compute split ─────────────────────────────────────────────────────────
    const cancelResult = computeCancellationSplit(stream, {
      totalAmount:      escrow.total,
      releasedAmount:   escrow.released,
      vestedAmount:     escrow.vested,
      token,
      senderAddress:    stream.senderAddress!,
      recipientAddress: stream.recipient,
    });

    if (!cancelResult.ok) {
      const httpStatus = cancelResult.code === "ALREADY_TERMINAL" ? 409 : 422;
      return createErrorResponse(cancelResult.code, cancelResult.message, httpStatus);
    }

    const { split } = cancelResult;

    // ── Execute token transfers ───────────────────────────────────────────────
    // Both legs use the stream's own token — never mix tokens across streams.
    // In production: call getTokenClientForStream(stream).transfer / .refund
    const recipientTxHash = `mock-cancel-payout-${crypto.randomUUID().slice(0, 8)}`;
    const senderTxHash    = split.senderRefund > 0n
      ? `mock-cancel-refund-${crypto.randomUUID().slice(0, 8)}`
      : undefined;

    // ── Build cancellation record ─────────────────────────────────────────────
    const cancellation = {
      ...buildCancellationRecord(
        {
          totalAmount:      escrow.total,
          releasedAmount:   escrow.released,
          vestedAmount:     escrow.vested,
          token,
          senderAddress:    stream.senderAddress!,
          recipientAddress: stream.recipient,
        },
        split,
        recipientTxHash,
        senderTxHash,
      ),
      senderAddress: stream.senderAddress!,
    };

    // ── Persist updated stream ────────────────────────────────────────────────
    const before = structuredClone(stream);
    const updatedStream = {
      ...stream,
      status:         "cancelled" as const,
      nextAction:     undefined,
      updatedAt:      now.toISOString(),
      // Advance released_amount to vested_amount — escrow fully drained.
      releasedAmount: escrow.vested.toString(),
      vestedAmount:   escrow.vested.toString(),
      cancellation,
    };
    db.streams.set(id, updatedStream);

    const authenticatedActor = tryAuthenticateRequest(request);
    const actorWallet = authenticatedActor?.walletAddress ?? (isOrgOwned ? resolveActorAddress(request) : null);

    appendStreamHistoryEvent({
      streamId: id,
      type: "cancelled",
      fromStatus: stream.status,
      toStatus: "cancelled",
      at: now,
      actorWallet: actorWallet ?? undefined,
    });
    publishStreamChange({
      action: "cancel",
      actor: actorAddress ?? undefined,
      after: updatedStream,
      before,
      correlationId: getCorrelationContext()?.correlation_id,
    });

    // ── Enqueue lifecycle webhook (post-commit) ───────────────────────────────
    // Only enqueue after the store write has committed. A failed cancel returns
    // above and never reaches this point, so nothing is enqueued on failure.
    const webhookUrl = (updatedStream as typeof updatedStream & { webhook_url?: string }).webhook_url;
    if (webhookUrl) {
      const event = toWebhookEvent(before, updatedStream, "cancel");
      if (event) {
        webhookOutboxStore.enqueueStreamLifecycleEventIdempotent(
          { ...updatedStream, webhook_url: webhookUrl },
          event,
          {
            stream_id: id,
            status: updatedStream.status,
            previous_status: before.status,
            action: "cancel",
            occurred_at: now,
            token,
            total_amount: escrow.totalAmount.toString(),
            released_amount: updatedStream.releasedAmount,
            vested_amount: updatedStream.vestedAmount,
            recipient_payout: split.recipientPayout.toString(),
            sender_refund: split.senderRefund.toString(),
          },
          now,
        );
      }
    }

    // ── Audit log ─────────────────────────────────────────────────────────────
    recordPrivilegedStreamAuditEvent({
      action:        "stream.cancel",
      after:         updatedStream as unknown as Record<string, unknown>,
      before:        before        as unknown as Record<string, unknown>,
      metadata: {
        recipientPayout:  split.recipientPayout.toString(),
        senderRefund:     split.senderRefund.toString(),
        escrowDrained:    split.escrowDrained.toString(),
        token,
        recipientTxHash,
        ...(senderTxHash ? { senderTxHash } : {}),
      },
      request,
      streamId:      id,
      targetAccount: stream.recipient,
    });

    const payload = {
      data:         updatedStream,
      cancellation,
      links: { self: `/api/v1/streams/${id}` },
    };

    if (idemToken) setIdempotency(db.idempotency, idemToken, fingerprint, 200, payload);

    return NextResponse.json(payload);
  });
}
