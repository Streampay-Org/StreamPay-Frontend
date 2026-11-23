/**
 * POST /api/v2/streams — create a stream, enforcing daily and configured quotas.
 * GET  /api/v2/streams — paginated stream list in v2 shape.
 *
 * Quota enforcement (POST only):
 *   Each calling identity (API key > wallet > IP) is treated as an "org"
 *   for quota purposes. The daily limit is configured in rate-limit-config.ts
 *   via ORG_DAILY_STREAM_QUOTA and can be tuned with the
 *   ORG_DAILY_STREAM_QUOTA_LIMIT env var without a code deploy.
 *
 *   When the quota is exceeded the handler returns 429 with a Retry-After
 *   header set to the number of seconds until UTC midnight, and a metric
 *   is emitted via org-quota-metrics.ts.
 *
 *   Admin-configured user/org active-stream and monthly XLM volume quotas are
 *   checked under the shared creation lock before the stream is persisted.
 *
 * Breaking changes vs v1:
 *   - Response body uses `allowed_actions`, `created_at`, `updated_at`
 *     instead of `nextAction`, `createdAt`, `updatedAt`.
 *   - `settlement` is always present (null when not yet settled).
 */

import { NextResponse } from "next/server";
import { db, encodeCursor, decodeCursor, idempotencyToken, getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { getClientIdentity } from "@/app/lib/rate-limit";
import { checkOrgDailyQuota, orgQuotaResponse } from "@/app/lib/org-quota";
import { toV2Stream, dbStreamToV1 } from "@/app/lib/api-version";
import type { Stream } from "@/app/types/openapi";
import { checkCreationQuota } from "@/app/lib/quota-enforcement";
import {
  creationQuotaResponse,
  quotaUserId,
  rateToStroops,
  withStreamCreationQuotaLock,
} from "@/app/lib/stream-create-core";
import { recordCreationQuotaRejection } from "@/app/lib/org-quota-metrics";
import { orgDb } from "@/app/lib/org-db";

function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** GET /api/v2/streams — paginated stream list in v2 shape. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor");
  const status = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);

  const { streamRepository } = getStore();
  let streams = Array.from(streamRepository.streams.values() as Iterable<Stream>).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  if (status) streams = streams.filter((s) => s.status === status);

  if (cursor) {
    const cursorId = decodeCursor(cursor);
    const idx = streams.findIndex((s) => s.id === cursorId);
    if (idx >= 0) streams = streams.slice(idx + 1);
  }

  const page = streams.slice(0, limit);
  const hasNext = streams.length > limit;
  const nextCursor =
    hasNext && page.length > 0
      ? encodeCursor(page[page.length - 1].id)
      : null;

  return NextResponse.json({
    streams: page.map((stream) => toV2Stream(dbStreamToV1(stream))),
    meta: { hasNext, nextCursor, total: streamRepository.streams.size },
    links: { self: `/api/v2/streams?limit=${limit}` },
  });
}

/**
 * POST /api/v2/streams — create a stream, respond with v2 shape.
 */
export async function POST(request: Request) {
  // ── 1. Idempotency ────────────────────────────────────────────────────────
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken("v2.streams.create", idempotencyKey)
    : null;

  if (token && db.idempotency.has(token)) {
    // Replayed request — return the cached response without counting against quota.
    return NextResponse.json(db.idempotency.get(token), { status: 201 });
  }

  // ── 2. Per-org daily quota ────────────────────────────────────────────────
  //
  // We use ClientIdentity.value as the org key:
  //   - API key callers   → keyed by their API key (most precise)
  //   - Wallet callers    → keyed by their Stellar public key
  //   - Unauthenticated   → keyed by IP (coarser, still prevents runaway billing)
  //
  // The quota is checked *before* body parsing so the 429 is returned cheaply
  // and the counter is incremented atomically inside checkOrgDailyQuota.
  const identity = getClientIdentity(request);
  const quota = await checkOrgDailyQuota(identity.value);

  if (!quota.allowed) {
    return orgQuotaResponse(quota.retryAfter!);
  }

  // ── 3. Parse and validate body ───────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  const { recipient, rate, schedule, orgId: rawOrgId } = body as {
    recipient?: string;
    rate?: string;
    schedule?: string;
    orgId?: string;
  };

  if (!recipient || !rate || !schedule) {
    return errorResponse(
      "VALIDATION_ERROR",
      "Missing required fields: recipient, rate, schedule",
      422,
    );
  }

  const rateMatch = /^(\d+(?:\.\d{1,7})?)(?:\s+.*)?$/.exec(rate.trim());
  if (!rateMatch || Number(rateMatch[1]) <= 0) {
    return errorResponse("VALIDATION_ERROR", "rate must be a positive decimal with at most 7 decimal places.", 422);
  }

  // ── 4. Persist and respond ────────────────────────────────────────────────
  const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const newStream: Stream = {
    id,
    recipient: String(recipient),
    rate: String(rate),
    schedule: String(schedule),
    status: "draft",
    nextAction: "start",
    createdAt: now,
    updatedAt: now,
    token: "XLM",
  };

  const userId = quotaUserId(identity);
  const orgId = typeof rawOrgId === "string" && rawOrgId.trim()
    ? rawOrgId.trim()
    : undefined;

  return withStreamCreationQuotaLock(async () => {
    if (token && db.idempotency.has(token)) {
      return NextResponse.json(db.idempotency.get(token), { status: 201 });
    }

    const quotaResult = checkCreationQuota({
      userId,
      orgId,
      amountStroops: rateToStroops(rate, "XLM"),
      now: new Date(now),
    });
    if (!quotaResult.allowed) {
      recordCreationQuotaRejection(
        quotaResult.scope,
        quotaResult.subject,
        quotaResult.code,
      );
      return creationQuotaResponse(quotaResult);
    }

    const storedStream: Stream = {
      ...newStream,
      ...(userId ? { senderAddress: userId } : {}),
    };
    db.streams.set(id, storedStream);
    if (orgId) orgDb.streamOwnership.set(id, orgId);

    const stream = toV2Stream(dbStreamToV1(newStream));
    if (token) db.idempotency.set(token, stream);

    return NextResponse.json(stream, { status: 201 });
  });
}
