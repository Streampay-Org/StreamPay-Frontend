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
import { idempotencyKeyErrorResponse, validateIdempotencyKey } from "@/app/lib/idempotency";
import { db, encodeCursor, decodeCursor, idempotencyToken, getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { db, idempotencyToken, getStore, newStreamId } from "@/app/lib/db";
import { filterStreamsByTag } from "@/app/lib/stream-tags";
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
import { buildLinkHeader, buildUrlWithParams } from "@/app/lib/link-header";
import type { Stream } from "@/app/types/openapi";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { checkCreationQuota } from "@/app/lib/quota-enforcement";
import {
  creationQuotaResponse,
  quotaUserId,
  rateToStroops,
  withStreamCreationQuotaLock,
} from "@/app/lib/stream-create-core";
import { recordCreationQuotaRejection } from "@/app/lib/org-quota-metrics";
import { orgDb } from "@/app/lib/org-db";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { createCacheHeaders, createStrongEtag, isIfNoneMatchMatch } from "@/src/middleware/etag";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import {
  resolveRequestActor,
  resolveRequestTenant,
  visibleTo,
} from "@/app/lib/stream-visibility";

/** Attempts at drawing a fresh stream id before giving up on a collision. */
const MAX_ID_ATTEMPTS = 3;


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
export async function GET(request: Request) {
  const url = new URL(request.url);
  const { searchParams } = url;
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const rateLimitResult = await checkRateLimit(identity, limitType);
  if (!rateLimitResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }
  recordRequest(url.pathname);

  const cursor = searchParams.get("cursor");
  const status = searchParams.get("status");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);
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

  const sortedStreams = (tenantCandidates as any[])
    .filter((stream: any) => !stream.deletedAt && isVisible(stream))
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

  const linkParams = { limit, status: statusFilter, cursor };
  const selfLink = buildUrlWithParams("/api/v2/streams", linkParams);
  const linkHeader = buildLinkHeader({
    baseUrl: "/api/v2/streams",
    params: linkParams,
    next: nextCursor,
    self: true,
  });

  const payload = {
    streams: projected,
    meta: { hasNext, nextCursor, total },
    links: { self: selfLink },
  };
  const etag = createStrongEtag(payload);
  const cacheHeaders: Record<string, string> = {
    ...createCacheHeaders(etag),
    ...(linkHeader ? { Link: linkHeader } : {}),
  };

  if (isIfNoneMatchMatch(etag, request.headers?.get?.("if-none-match") ?? null)) {
    return new NextResponse(null, {
      status: 304,
      headers: cacheHeaders,
    });
  }

  const response = NextResponse.json(payload);
  for (const [name, value] of Object.entries(cacheHeaders)) {
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
export async function POST(request: Request) {
  const url = new URL(request.url);
  const limitType = getLimitForRoute("POST", url.pathname);
  const identity = getClientIdentity(request);
  const rateLimitResult = await checkRateLimit(identity, limitType);
  if (!rateLimitResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }
  recordRequest(url.pathname);
async function handleV2StreamsPost(request: Request) {
  if (!request.headers.get("authorization")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  // ── 1. Idempotency ────────────────────────────────────────────────────────
  const rawIdempotencyKey = request.headers.get("Idempotency-Key");
  let idempotencyKey: string | null = null;
  if (rawIdempotencyKey !== null) {
    const keyValidation = validateIdempotencyKey(rawIdempotencyKey);
    if (!keyValidation.ok) {
      return idempotencyKeyErrorResponse(keyValidation.reason);
    }
    idempotencyKey = keyValidation.key;
  }
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
      "One or more fields are invalid.",
      422,
    );
  }

  const rateMatch = /^(\d+(?:\.\d{1,7})?)(?:\s+.*)?$/.exec(rate.trim());
  if (!rateMatch || Number(rateMatch[1]) <= 0) {
    return errorResponse("VALIDATION_ERROR", "rate must be a positive decimal with at most 7 decimal places.", 422);
  }

  // ── 4. Persist and respond ────────────────────────────────────────────────
  const authenticatedActor = tryAuthenticateRequest(request);
  const senderAddress = authenticatedActor?.walletAddress ?? null;
  const ownership: "individual" | "unclaimed" = authenticatedActor ? "individual" : "unclaimed";

  const now = new Date().toISOString();
  const explicitTenant =
    request.headers.get("x-tenant-id")?.trim() ||
    request.headers.get("x-streampay-tenant-id")?.trim() ||
    undefined;
  const baseStream: Omit<Stream, "id"> = {
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
    ...(explicitTenant ? { tenant: explicitTenant } : {}),
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
  // Create-only insert: never overwrite an existing stream on an id collision.
  const { streamRepository } = getStore();
  let newStream: Stream | null = null;
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS && !newStream; attempt++) {
    const candidate: Stream = { ...baseStream, id: newStreamId() };
    if (streamRepository.streams.insert(candidate.id, candidate)) {
      newStream = candidate;
    }
  }

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
