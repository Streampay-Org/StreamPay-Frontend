/**
 * POST /api/v2/streams — create a stream, enforcing a per-org daily quota.
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
import { withRouteTimeout } from "@/src/middleware/timeout";


function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

/** Deterministic stream ID generator for idempotent requests. */
function createStreamId(idempotencyKey?: string | null): string {
  if (!idempotencyKey) {
    return `stream-${crypto.randomUUID().slice(0, 8)}`;
  }
  let hash = 0;
  for (let i = 0; i < idempotencyKey.length; i++) {
    const chr = idempotencyKey.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `stream-${Math.abs(hash).toString(36).slice(0, 8)}`;
}

/** GET /api/v2/streams — paginated stream list in v2 shape. */
async function handleV2StreamsGet(request: Request) {
  if (!request.headers.get("authorization")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor");
  const status = searchParams.get("status");
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;

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

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleV2StreamsGet(request));
}

/**
 * POST /api/v2/streams — create a stream, respond with v2 shape.
 */
async function handleV2StreamsPost(request: Request) {
  if (!request.headers.get("authorization")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  // ── 1. Idempotency ────────────────────────────────────────────────────────
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken("v2.streams.create", idempotencyKey)
    : null;

  if (token && db.idempotency.has(token)) {
    // Replayed request — return the cached response without counting against quota.
    return NextResponse.json(db.idempotency.get(token), { status: 201 });
  }

  // ── 2. Parse and validate body ───────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  const { recipient, rate, schedule } = body as {
    recipient?: string;
    rate?: string;
    schedule?: string;
  };

  if (!recipient || !rate || !schedule) {
    return errorResponse(
      "VALIDATION_ERROR",
      "One or more fields are invalid.",
      422,
    );
  }

  // ── 3. Per-org daily quota ────────────────────────────────────────────────
  //
  // We use ClientIdentity.value as the org key:
  //   - API key callers   → keyed by their API key (most precise)
  //   - Wallet callers    → keyed by their Stellar public key
  //   - Unauthenticated   → keyed by IP (coarser, still prevents runaway billing)
  //
  // The quota is checked *after* body parsing/validation so that invalid
  // requests do not consume quota (this keeps quota accounting deterministic
  // and prevents using invalid requests to exhaust the daily limit).
  const identity = getClientIdentity(request);
  const quota = await checkOrgDailyQuota(identity.value);

  if (!quota.allowed) {
    return orgQuotaResponse(quota.retryAfter!);
  }

  // ── 4. Persist and respond ────────────────────────────────────────────────
  const id = createStreamId(idempotencyKey);
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

  db.streams.set(id, newStream);

  const stream = toV2Stream(dbStreamToV1(newStream));
  const payload = stream;
 
  if (token) db.idempotency.set(token, payload);
 
  return NextResponse.json(payload, { status: 201 });
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleV2StreamsPost(request));
}
