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
import { db, idempotencyToken, getStore } from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { getClientIdentity } from "@/app/lib/rate-limit";
import { checkOrgDailyQuota, orgQuotaResponse } from "@/app/lib/org-quota";
import { toV2Stream, dbStreamToV1, ProjectionError } from "@/app/lib/api-version";
import { validateListStreamsQuery } from "@/app/lib/stream-validation";
import {
  decodeStreamCursor,
  encodeStreamCursor,
  isAfterCursor,
  type StreamCursor,
} from "@/app/lib/stream-cursor";
import type { Stream } from "@/app/types/openapi";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { tryAuthenticateRequest } from "@/app/lib/auth";


function errorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
  return NextResponse.json({ error: { code, message, request_id: requestId } }, { status });
}

function getRequestUrl(request: Request, fallbackPath: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
  } catch {
    return new URL(`http://localhost${fallbackPath}`);
  }
}

/** GET /api/v2/streams — paginated stream list in v2 shape. */
async function handleV2StreamsGet(request: Request) {
  if (!request.headers.get("authorization")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  const { searchParams } = getRequestUrl(request, "/api/v2/streams");
  const rawQuery: Record<string, string> = {};
  for (const key of ["limit", "status", "cursor"] as const) {
    const value = searchParams.get(key);
    if (value !== null) {
      rawQuery[key] = value;
    }
  }

  const { errors: queryErrors, values: query } = validateListStreamsQuery(rawQuery);
  if (queryErrors.length > 0) {
    const [firstError] = queryErrors;
    return errorResponse(firstError.code, firstError.message, 422);
  }

  const cursor = query.cursor ?? null;
  const statusFilter = query.status ?? null;
  const limit = query.limit ?? 20;

  const tenant = resolveRequestTenant(request);
  const actor = resolveRequestActor(request);
  const isVisible = visibleTo(actor, tenant);

  const { streamRepository } = getStore();
  const tenantCandidates = streamRepository.listByTenant
    ? streamRepository.listByTenant(tenant)
    : Array.from(streamRepository.streams.values() as Iterable<Stream>);

  const sortedStreams = tenantCandidates
    .filter(isVisible)
    .sort((a, b) => {
      const timeCompare = a.createdAt.localeCompare(b.createdAt);
      return timeCompare !== 0 ? timeCompare : a.id.localeCompare(b.id);
    });

  let streams = statusFilter
    ? sortedStreams.filter((stream) => stream.status === statusFilter)
    : sortedStreams;

  if (cursor) {
    let keyset: StreamCursor;
    try {
      keyset = decodeStreamCursor(cursor, {
        resolveLegacyId: (legacyId) => {
          const legacy = streamRepository.streams.get(legacyId);
          if (!legacy || !isVisible(legacy)) {
            return null;
          }
          logger.warn("Deprecated plain-id pagination cursor used", {
            streamId: legacyId,
          });
          return { createdAt: legacy.createdAt, id: legacy.id };
        },
      });
    } catch {
      return errorResponse(
        "INVALID_CURSOR",
        "Cursor is malformed or refers to a stream that no longer exists.",
        422,
      );
    }

    const cursorTarget = streamRepository.streams.get(keyset.id);
    if (cursorTarget && !isVisible(cursorTarget)) {
      return errorResponse(
        "INVALID_CURSOR",
        "Cursor is malformed or refers to a stream that no longer exists.",
        422,
      );
    }

    streams = streams.filter((stream) => isAfterCursor(stream, keyset));
  }

  const total = streams.length;
  const page = streams.slice(0, limit);
  const hasNext = streams.length > limit;
  const nextCursor =
    hasNext && page.length > 0
      ? encodeStreamCursor(page[page.length - 1])
      : null;

  let projected;
  try {
    projected = page.map((stream) => toV2Stream(dbStreamToV1(stream)));
  } catch (err) {
    if (err instanceof ProjectionError) {
      return errorResponse("PROJECTION_ERROR", err.message, 500);
    }
    throw err;
  }

  return NextResponse.json({
    streams: projected,
    meta: { hasNext, nextCursor, total: streamRepository.streams.size },
    links: { self: `/api/v2/streams?limit=${limit}` },
  };
  const etag = createStrongEtag(payload);

  if (isIfNoneMatchMatch(etag, request.headers?.get?.("if-none-match") ?? null)) {
    return new NextResponse(null, {
      status: 304,
      headers: createCacheHeaders(etag),
    });
  }

  const response = NextResponse.json(payload);
  for (const [name, value] of Object.entries(createCacheHeaders(etag))) {
    response.headers.set(name, value);
  }
  return response;
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

  // ── 4. Persist and respond ────────────────────────────────────────────────
  const authenticatedActor = tryAuthenticateRequest(request);
  const senderAddress = authenticatedActor?.walletAddress ?? null;
  const ownership: "individual" | "unclaimed" = authenticatedActor ? "individual" : "unclaimed";

  const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const explicitTenant =
    request.headers.get("x-tenant-id")?.trim() ||
    request.headers.get("x-streampay-tenant-id")?.trim() ||
    undefined;
  const actor = resolveRequestActor(request);
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
    senderAddress,
    ownership,
  };

  if (!newStream) {
    return errorResponse("ID_GENERATION_FAILED", "Failed to generate unique stream identifier", 500);
  }

  const stream = toV2Stream(dbStreamToV1(newStream));
  const payload = stream;
 
  if (token) db.idempotency.set(token, payload);
 
  return NextResponse.json(payload, { status: 201 });
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleV2StreamsPost(request));
}
