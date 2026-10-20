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
import {
  checkIdempotency,
  computeFingerprint,
  idempotencyToken,
  setIdempotency,
  getStore,
} from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { getClientIdentity } from "@/app/lib/rate-limit";
import { checkOrgDailyQuota, orgQuotaResponse } from "@/app/lib/org-quota";
import { toV2Stream, dbStreamToV1, type StreamV2 } from "@/app/lib/api-version";
import { validateListStreamsQuery } from "@/app/lib/stream-validation";
import {
  decodeStreamCursor,
  encodeStreamCursor,
  isAfterCursor,
  type StreamCursor,
} from "@/app/lib/stream-cursor";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { createStreamCore } from "@/app/lib/stream-core";


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

  const { streamRepository } = getStore();
  const sortedStreams = Array.from(
    streamRepository.streams.values() as Iterable<Stream>,
  ).sort((a, b) => {
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
          if (!legacy) {
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
    streams = streams.filter((stream) => isAfterCursor(stream, keyset));
  }

  const page = streams.slice(0, limit);
  const hasNext = streams.length > limit;
  const nextCursor =
    hasNext && page.length > 0
      ? encodeStreamCursor(page[page.length - 1])
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
  const { idempotencyStore } = getStore();

  // ── 1. Parse JSON body ───────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }

  // ── 2. Idempotency check ─────────────────────────────────────────────────
  const idempotencyKey = request.headers.get("Idempotency-Key");
  const token = idempotencyKey
    ? idempotencyToken("v2.streams.create", idempotencyKey)
    : null;

  const fingerprint = computeFingerprint("POST", "/api/v2/streams", body);

  if (token) {
    const cached = checkIdempotency(idempotencyStore, token, fingerprint);
    if (cached) {
      if (!cached.ok) {
        return NextResponse.json(
          {
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Idempotency key has been used with a different request.",
              request_id: getCorrelationContext()?.request_id,
            },
          },
          { status: 409 },
        );
      }
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  // ── 3. Validate, check allowlist, charge quota, and persist via shared core
  const authenticatedActor = tryAuthenticateRequest(request);
  const senderAddress = authenticatedActor?.walletAddress ?? null;
  const ownership: "individual" | "unclaimed" = authenticatedActor ? "individual" : "unclaimed";
  const actorWallet = request.headers.get("Actor-Wallet-Address") ?? senderAddress;

  const coreResult = await createStreamCore({
    body,
    actorWallet,
    senderAddress,
    ownership,
    beforePersist: async () => {
      const identity = getClientIdentity(request);
      const quota = await checkOrgDailyQuota(identity.value);
      if (!quota.allowed) {
        return { ok: false, response: orgQuotaResponse(quota.retryAfter!) };
      }
      return { ok: true };
    },
  });

  if (!coreResult.ok) {
    if (coreResult.response) {
      return coreResult.response;
    }
    if (coreResult.details) {
      const requestId = getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`;
      return NextResponse.json(
        {
          error: {
            code: coreResult.code,
            message: coreResult.message,
            details: coreResult.details,
            request_id: requestId,
          },
        },
        { status: coreResult.status },
      );
    }
    return errorResponse(coreResult.code, coreResult.message, coreResult.status);
  }

  const streamV2 = toV2Stream(dbStreamToV1(coreResult.stream));
  const { createdAt: _ca, nextAction: _na, updatedAt: _ua, ...cleanV2 } = streamV2 as StreamV2 & {
    createdAt?: string;
    nextAction?: string;
    updatedAt?: string;
  };
  const data = {
    ...cleanV2,
    updated_at: coreResult.stream.updatedAt,
  };
  const payload = {
    ...streamV2,
    updated_at: coreResult.stream.updatedAt,
    data,
    links: { self: `/api/v2/streams/${streamV2.id}` },
  };

  if (token) {
    setIdempotency(idempotencyStore, token, fingerprint, 201, payload);
  }

  return NextResponse.json(payload, { status: 201 });
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleV2StreamsPost(request));
}

