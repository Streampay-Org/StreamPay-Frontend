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
import { checkStreamOrgPolicy, resolveActorAddress } from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { tryAuthenticateRequest } from "@/app/lib/auth";
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
import { addToOutbox } from "@/app/lib/webhook-outbox";
import { toWebhookEvent } from "@/app/lib/stream-webhook-events";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createErrorResponse(code: string, message: string, status: number) {
  const ctx = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: ctx?.request_id } },
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

// ── Mock escrow-state resolver ────────────────────────────────────────────────
// In production this would query the Soroban contract storage for the stream's
// current vested_amount, released_amount, and total_amount.
// Amounts are i128 raw units — no per-decimal logic here.
function resolveEscrowState(streamId: string): {
  totalAmount: bigint;
  releasedAmount: bigint;
  vestedAmount: bigint;
} {
  // Mock: use deterministic values keyed by stream ID for testability.
  // Replace with real Soroban RPC call in production.
  const mockEscrow: Record<string, { totalAmount: bigint; releasedAmount: bigint; vestedAmount: bigint }> = {
    "stream-ada":  { totalAmount: 3_600_000_000n, releasedAmount: 1_200_000_000n, vestedAmount: 1_800_000_000n },
    "stream-kemi": { totalAmount: 1_280_000_000n, releasedAmount: 0n,             vestedAmount: 0n             },
  };
  return mockEscrow[streamId] ?? { totalAmount: 1_000_000_000n, releasedAmount: 0n, vestedAmount: 500_000_000n };
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
    // Three ownership states:
    // 1. Org-owned: org policy via RBAC helper (canceller role required)
    // 2. Unclaimed (no recorded sender): 403 SENDER_UNKNOWN (never cancellable)
    // 3. Individually owned: verified JWT actor must equal stream.senderAddress (otherwise 403 SENDER_AUTH_REQUIRED)

    const isOrgOwned = orgDb.streamOwnership.has(id) || stream.ownership === "org";

    if (isOrgOwned) {
      if (!stream.senderAddress) {
        return createErrorResponse(
          "SENDER_UNKNOWN",
          "Stream has no recorded sender and cannot be cancelled",
          403,
        );
      }
      const actor = resolveActorAddress(request);
      if (!actor) {
        return createErrorResponse(
          "ACTOR_REQUIRED",
          "A verified actor identity is required for this action.",
          403,
        );
      }
      const policyResult = checkStreamOrgPolicy(id, actor, "stop");
      if (policyResult) {
        if (!policyResult.allowed) {
          return createErrorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
        }
        if (policyResult.requiresApproval) {
          return createErrorResponse(
            "APPROVAL_REQUIRED",
            "This cancellation requires multi-sig approval. Please initiate an approval request.",
            409,
          );
        }
      }
    } else {
      if (stream.ownership === "unclaimed" || !stream.senderAddress) {
        return createErrorResponse(
          "SENDER_UNKNOWN",
          "Stream is unclaimed and cannot be cancelled",
          403,
        );
      }

      const jwtActor = tryAuthenticateRequest(request);
      if (!jwtActor || jwtActor.walletAddress !== stream.senderAddress) {
        return createErrorResponse(
          "SENDER_AUTH_REQUIRED",
          "Only the stream sender can cancel this stream",
          403,
        );
      }
    }

    // ── Resolve escrow state ──────────────────────────────────────────────────
    const escrow = resolveEscrowState(id);
    const token  = stream.token ?? "XLM";

    // ── Compute split ─────────────────────────────────────────────────────────
    const cancelResult = computeCancellationSplit(stream, {
      totalAmount:      escrow.totalAmount,
      releasedAmount:   escrow.releasedAmount,
      vestedAmount:     escrow.vestedAmount,
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
          totalAmount:      escrow.totalAmount,
          releasedAmount:   escrow.releasedAmount,
          vestedAmount:     escrow.vestedAmount,
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
    const now    = new Date().toISOString();
    const updatedStream = {
      ...stream,
      status:         "cancelled" as const,
      nextAction:     undefined,
      updatedAt:      now,
      // Advance released_amount to vested_amount — escrow fully drained.
      releasedAmount: escrow.vestedAmount.toString(),
      vestedAmount:   escrow.vestedAmount.toString(),
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
    if (updatedStream.webhook_url) {
      const event = toWebhookEvent(before, updatedStream, "cancel");
      if (event) {
        addToOutbox({
          eventId: `evt_${id}_cancel_${now}`,
          eventType: event,
          streamId: id,
          url: updatedStream.webhook_url,
          data: {
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
        });
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
