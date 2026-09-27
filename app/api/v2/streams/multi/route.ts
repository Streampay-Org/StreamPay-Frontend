/**
 * POST /api/v2/streams/multi
 *
 * Create a multi-recipient (fan-out) stream: one stream row per recipient,
 * each locked to its own share of the total and sharing the same start/end
 * window. The endpoint is documented in `docs/api/multi-recipient-stream.md`.
 *
 * Guarantees
 * ----------
 * • The allocation is validated before anything is written, so a rejected
 *   request leaves no partial fan-out behind.
 * • The sum of the per-recipient amounts equals `total_amount` exactly
 *   (see `deriveAllocationAmounts`), so no dust is stranded in escrow.
 * • `Idempotency-Key` replays return the original 201 body; reusing a key
 *   with a different body is a 409 rather than a duplicate fan-out.
 * • The per-org daily quota is charged once per fan-out, not once per leg.
 *
 * Status codes
 * ------------
 * | Status | Code                          | When                                        |
 * |--------|-------------------------------|---------------------------------------------|
 * | 201    | —                             | Fan-out created                             |
 * | 400    | `INVALID_REQUEST`             | Body is not valid JSON                      |
 * | 401    | `UNAUTHORIZED`                | Missing `Authorization: Bearer …`           |
 * | 409    | `IDEMPOTENCY_CONFLICT`        | Key reused with a different body            |
 * | 422    | `VALIDATION_ERROR`            | Allocation / field rules violated           |
 * | 429    | `ORG_DAILY_QUOTA_EXCEEDED`    | Daily stream quota reached                  |
 * | 504    | `GATEWAY_TIMEOUT`             | Handler exceeded the route deadline         |
 */

import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  getStore,
  idempotencyToken,
  setIdempotency,
} from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { getClientIdentity } from "@/app/lib/rate-limit";
import { checkOrgDailyQuota, orgQuotaResponse } from "@/app/lib/org-quota";
import {
  formatAmount,
  formatPercentage,
  resolveAllocations,
  toIsoUtc,
  validateMultiRecipientStreamBody,
  type MultiRecipientValidationError,
} from "@/app/lib/multi-recipient";
import type { Stream } from "@/app/types/openapi";
import { withRouteTimeout } from "@/src/middleware/timeout";

/** Idempotency scope, kept distinct from single-recipient stream creation. */
const IDEMPOTENCY_SCOPE = "v2.streams.multi";

/**
 * A leg of a fan-out. It is an ordinary stream (so the existing
 * start/pause/settle lifecycle applies) carrying the extra allocation
 * metadata that ties it back to its group.
 */
interface MultiRecipientLeg extends Stream {
  /** Identifier of the fan-out this leg belongs to. */
  multiGroupId: string;
  /** Human-readable fan-out name. */
  multiName: string;
  /** 1-based position of this leg within the allocation. */
  multiRank: number;
  /** Total number of legs in the fan-out. */
  multiLegCount: number;
  /** Share of the total, as a fixed 4-decimal string. */
  multiPercentage: string;
  /** Fan-out window, ISO-8601 UTC. */
  multiStartAt: string;
  multiEndAt: string;
}

/** A single entry of the 201 manifest. */
interface MultiRecipientLegSummary {
  rank: number;
  stream_id: string;
  address: string;
  percentage: string;
  amount: string;
}

/** The 201 body returned by this endpoint. */
interface MultiRecipientStreamResponse {
  id: string;
  kind: "multi_recipient";
  name: string;
  token: string;
  status: "draft";
  total_amount: string;
  allocated_percentage: string;
  recipient_count: number;
  start_at: string;
  end_at: string;
  created_at: string;
  settlement: null;
  recipients: MultiRecipientLegSummary[];
  links: { self: string; collection: string };
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown,
) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: requestId,
        ...(details ? { details } : {}),
      },
    },
    { status },
  );
}

/**
 * Describe a leg's release rate over the fan-out window.
 *
 * The window is guaranteed to be at least one second wide by validation, so
 * the division is always safe; the clamp is defensive only.
 */
function describeRate(amount: number, token: string, windowSeconds: number): string {
  const seconds = Math.max(1, windowSeconds);
  return `${formatAmount(amount / seconds)} ${token}/s`;
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleMultiRecipientPost(request));
}

async function handleMultiRecipientPost(request: Request) {
  // ── 1. Authentication ──────────────────────────────────────────────────────
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  // ── 2. Body ────────────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON.", 400);
  }

  // ── 3. Idempotency ─────────────────────────────────────────────────────────
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const cacheToken = idempotencyKey
    ? idempotencyToken(IDEMPOTENCY_SCOPE, idempotencyKey)
    : null;
  const fingerprint = computeFingerprint("POST", "/api/v2/streams/multi", body);

  if (cacheToken) {
    const { idempotencyStore } = getStore();
    const cached = checkIdempotency(idempotencyStore, cacheToken, fingerprint);

    if (cached) {
      if (!cached.ok) {
        return errorResponse(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key has been used with a different request.",
          409,
        );
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  // ── 4. Per-org daily quota (charged once per fan-out) ──────────────────────
  const identity = getClientIdentity(request);
  const quota = await checkOrgDailyQuota(identity.value);

  if (!quota.allowed) {
    return orgQuotaResponse(quota.retryAfter!);
  }

  // ── 5. Validation ──────────────────────────────────────────────────────────
  const validationErrors: MultiRecipientValidationError[] =
    validateMultiRecipientStreamBody(body);

  if (validationErrors.length > 0) {
    logger.warn("Multi-recipient stream validation failed", {
      errors: validationErrors,
      recipient_count: Array.isArray((body as Record<string, unknown>)?.recipients)
        ? ((body as Record<string, unknown>).recipients as unknown[]).length
        : undefined,
    });
    return errorResponse(
      "VALIDATION_ERROR",
      "One or more fields are invalid.",
      422,
      validationErrors,
    );
  }

  // Validation guarantees every field below, so the cast is safe.
  const validated = body as {
    name: string;
    token: string;
    totalAmount: number;
    startTime: string;
    endTime: string;
    recipients: Array<{ address: string; percentage: number; amount?: number }>;
  };

  // ── 6. Resolve the allocation ──────────────────────────────────────────────
  const name = validated.name.trim();
  const asset = validated.token.trim();
  const totalAmount = validated.totalAmount;
  const startAt = toIsoUtc(validated.startTime);
  const endAt = toIsoUtc(validated.endTime);
  const windowSeconds = Math.max(
    1,
    Math.round((Date.parse(endAt) - Date.parse(startAt)) / 1000),
  );

  const allocations = resolveAllocations(totalAmount, validated.recipients);
  const allocatedPercentage = allocations.reduce((sum, a) => sum + a.percentage, 0);
  const groupId = `stream-multi-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const { streamRepository } = getStore();

  // ── 7. Persist every leg ───────────────────────────────────────────────────
  const recipients: MultiRecipientLegSummary[] = allocations.map((allocation, index) => {
    const legId = `stream-${crypto.randomUUID().slice(0, 8)}`;
    const amountText = formatAmount(allocation.amount);

    const leg: MultiRecipientLeg = {
      id: legId,
      recipient: allocation.address,
      rate: describeRate(allocation.amount, asset, windowSeconds),
      schedule: `${startAt} -> ${endAt}`,
      status: "draft",
      nextAction: "start",
      createdAt: now,
      updatedAt: now,
      token: asset,
      totalAmount: amountText,
      multiGroupId: groupId,
      multiName: name,
      multiRank: index + 1,
      multiLegCount: allocations.length,
      multiPercentage: formatPercentage(allocation.percentage),
      multiStartAt: startAt,
      multiEndAt: endAt,
    };

    streamRepository.streams.set(legId, leg);

    return {
      rank: index + 1,
      stream_id: legId,
      address: allocation.address,
      percentage: leg.multiPercentage,
      amount: amountText,
    };
  });

  const payload: MultiRecipientStreamResponse = {
    id: groupId,
    kind: "multi_recipient",
    name,
    token: asset,
    status: "draft",
    total_amount: formatAmount(totalAmount),
    allocated_percentage: formatPercentage(allocatedPercentage),
    recipient_count: recipients.length,
    start_at: startAt,
    end_at: endAt,
    created_at: now,
    settlement: null,
    recipients,
    links: { self: "/api/v2/streams/multi", collection: "/api/v2/streams" },
  };

  if (cacheToken) {
    setIdempotency(
      getStore().idempotencyStore,
      cacheToken,
      fingerprint,
      201,
      payload,
    );
  }

  return NextResponse.json(payload, { status: 201 });
}
