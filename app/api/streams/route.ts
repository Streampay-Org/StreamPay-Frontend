import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import {
  checkIdempotency,
  computeFingerprint,
  getStore,
  idempotencyToken,
  setIdempotency,
  withLock,
} from "@/app/lib/db";
import {
  decodeStreamCursor,
  encodeStreamCursor,
  isAfterCursor,
  type StreamCursor,
} from "@/app/lib/stream-cursor";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { logAccessEvent } from "@/src/middleware/accessLog";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import {
  validateListStreamsQuery,
} from "@/app/lib/stream-validation";
import { createCacheHeaders, createStrongEtag, isIfNoneMatchMatch } from "@/src/middleware/etag";
import { observeStreamsRequest } from "@/src/metrics/registry";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { createStreamCore } from "@/app/lib/stream-create-core";
import { appendStreamHistoryEvent } from "@/app/lib/stream-history-writer";
import {
  redactStreamPii,
  resolveRequestActor,
  resolveRequestTenant,
  visibleTo,
} from "@/app/lib/stream-visibility";

function errorResponse(code: string, message: string, status: number) {
  return createErrorResponse(code, message, status);
}

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function getRequestUrl(request: Request, fallbackPath: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
  } catch {
    return new URL(`http://localhost${fallbackPath}`);
  }
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

type AccessLogContext = {
  method: "GET" | "POST";
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
};

function emitAccessEvent(context: AccessLogContext) {
  try {
    logAccessEvent(context);
  } catch (error) {
    logger.warn("Failed to emit access log event", { error });
  }
}

function durationMsFrom(start: [number, number]): number {
  const [seconds, nanoseconds] = process.hrtime(start);
  return seconds * 1000 + nanoseconds / 1_000_000;
}

function isTimeoutResponse(response: Response): boolean {
  return response.status === 504;
}

function wrapWithTimeout(
  request: Request,
  method: "GET" | "POST",
  path: string,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> {
  const start = process.hrtime();
  return withRouteTimeout(request, async () => {
    const response = await handler(request);
    if (isTimeoutResponse(response)) {
      emitAccessEvent({
        method,
        path,
        status: response.status,
        durationMs: durationMsFrom(start),
        errorCode: "GATEWAY_TIMEOUT",
      });
    }
    return response;
  });
}

async function handleStreamsGet(request: Request) {
  const start = process.hrtime();
  let status = 200;

  try {
    const { streamRepository } = getStore();
    const rateLimitResult = await streamsRateLimit(request, "GET", "/api/streams");
    if (!rateLimitResult.allowed) {
      status = rateLimitResult.response.status;
      return rateLimitResult.response;
    }

    const url = getRequestUrl(request, "/api/streams");
    const { searchParams } = url;
    const rawQuery: Record<string, string> = {};
    for (const key of ["limit", "status", "cursor"] as const) {
      const value = searchParams.get(key);
      if (value !== null) {
        rawQuery[key] = value;
      }
    }

    const { errors: queryErrors, values: query } = validateListStreamsQuery(rawQuery);
    if (queryErrors.length > 0) {
      status = 422;
      logger.warn("Stream list validation failed", { errors: queryErrors });
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "One or more query parameters are invalid.",
            details: queryErrors,
            request_id: getCorrelationContext()?.request_id,
          },
        },
        { status },
      );
    }

    const cursor = query.cursor ?? null;
    const streamStatus = query.status ?? null;
    const limit = query.limit ?? 20;

    const tenant = resolveRequestTenant(request);
    const actor = resolveRequestActor(request);
    const isVisible = visibleTo(actor, tenant);

    const tenantCandidates = streamRepository.listByTenant
      ? streamRepository.listByTenant(tenant)
      : Array.from(streamRepository.streams.values());

    const sortedStreams = tenantCandidates
      .filter(isVisible)
      .sort((left, right) => {
        const timeCompare = left.createdAt.localeCompare(right.createdAt);
        return timeCompare !== 0 ? timeCompare : left.id.localeCompare(right.id);
      });

    let streams = streamStatus
      ? sortedStreams.filter((stream) => stream.status === streamStatus)
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
        status = 422;
        return errorResponse(
          "INVALID_CURSOR",
          "Cursor is malformed or refers to a stream that no longer exists.",
          422,
        );
      }

      const cursorTarget = streamRepository.streams.get(keyset.id);
      if (cursorTarget && !isVisible(cursorTarget)) {
        status = 422;
        return errorResponse(
          "INVALID_CURSOR",
          "Cursor is malformed or refers to a stream that no longer exists.",
          422,
        );
      }

      streams = streams.filter((stream) => isAfterCursor(stream, keyset));
    }

    const total = streams.length;
    const rawPage = streams.slice(0, limit);
    const paginatedStreams = actor ? rawPage : rawPage.map(redactStreamPii);
    const hasNext = streams.length > limit;
    const nextCursor =
      hasNext && rawPage.length > 0
        ? encodeStreamCursor(rawPage[rawPage.length - 1])
        : null;

    const payload = {
      data: paginatedStreams,
      links: { self: `/api/v1/streams?limit=${limit}` },
      meta: { hasNext, nextCursor, total },
    };
    const etag = createStrongEtag(payload);

    if (isIfNoneMatchMatch(etag, getHeader(request, "if-none-match"))) {
      status = 304;
      return new NextResponse(null, {
        status,
        headers: createCacheHeaders(etag),
      });
    }

    logger.info("Streams listed successfully", {
      count: paginatedStreams.length,
      total,
    });

    const response = NextResponse.json(payload);
    for (const [name, value] of Object.entries(createCacheHeaders(etag))) {
      response.headers.set(name, value);
    }
    status = 200;
    return response;
  } catch (error) {
    status = 500;
    logger.error("Streams list failed", { error });
    return createErrorResponse("INTERNAL_ERROR", "Internal Server Error", 500);
  } finally {
    observeStreamsRequest("GET", status, start);
    emitAccessEvent({
      method: "GET",
      path: "/api/streams",
      status,
      durationMs: durationMsFrom(start),
      ...(status >= 400 ? { errorCode: statusToErrorCode(status) } : {}),
    });
  }
}

export async function GET(request: Request) {
  return wrapWithTimeout(request, "GET", "/api/streams", handleStreamsGet);
}

async function handleStreamsPost(request: Request) {
  const start = process.hrtime();
  let status = 201;

  try {
    const { idempotencyStore } = getStore();
    const rateLimitResult = await streamsRateLimit(request, "POST", "/api/streams");
    if (!rateLimitResult.allowed) {
      status = rateLimitResult.response.status;
      return rateLimitResult.response;
    }

    const idempotencyKey = getHeader(request, "Idempotency-Key");
    const token = idempotencyKey ? idempotencyToken("streams.create", idempotencyKey) : null;

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      status = 400;
      return errorResponse("INVALID_REQUEST", "Request body must be valid JSON", 400);
    }

    const fingerprint = computeFingerprint("POST", "/api/streams", body);

    if (token) {
      const cached = checkIdempotency(idempotencyStore, token, fingerprint);
      if (cached) {
        if (!cached.ok) {
          status = 409;
          return NextResponse.json(
            { error: { code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key has been used with a different request." } },
            { status },
          );
        }
        status = cached.status;
        return NextResponse.json(cached.body, { status: cached.status });
      }
    }

    const { totalAmount, startTime, endTime } = body as {
      totalAmount?: string;
      startTime?: string;
      endTime?: string;
    };
    const authenticatedActor = tryAuthenticateRequest(request);
    const senderAddress = authenticatedActor?.walletAddress ?? null;
    const ownership: "individual" | "unclaimed" = authenticatedActor ? "individual" : "unclaimed";

    const result = await createStreamCore(body, {
      dryRun: false,
      extras: {
        ...(totalAmount === undefined ? {} : { totalAmount, releasedAmount: "0", vestedAmount: "0" }),
        ...(startTime === undefined ? {} : { startTime, endTime }),
        senderAddress,
        ownership,
      },
    });
    if (!result.ok) {
      status = 422;
      if (result.code === "VALIDATION_ERROR") {
        logger.warn("Stream creation validation failed", { errors: result.details });
      } else if (result.code === "TOKEN_NOT_ALLOWED") {
        logger.warn("Stream creation rejected: token not in allowlist");
      }
      return NextResponse.json(
        {
          error: {
            code: result.code,
            message: result.message,
            ...(result.details ? { details: result.details } : {}),
            request_id: getCorrelationContext()?.request_id,
          },
        },
        { status },
      );
    }

    const stream = result.stream;

    appendStreamHistoryEvent({
      streamId: stream.id,
      type: "created",
      toStatus: "draft",
      at: stream.createdAt,
      actorWallet: getHeader(request, "Actor-Wallet-Address"),
    });

    const payload = { data: stream, links: { self: `/api/v1/streams/${stream.id}` } };

    if (token) {
      setIdempotency(idempotencyStore, token, fingerprint, 201, payload);
    }

    status = 201;
    return NextResponse.json(payload, { status: 201 });
  } catch (error) {
    status = 500;
    logger.error("Stream creation failed", { error });
    return createErrorResponse("INTERNAL_ERROR", "Internal Server Error", 500);
  } finally {
    observeStreamsRequest("POST", status, start);
    emitAccessEvent({
      method: "POST",
      path: "/api/streams",
      status,
      durationMs: durationMsFrom(start),
      ...(status >= 400 ? { errorCode: statusToErrorCode(status) } : {}),
    });
  }
}

export async function POST(request: Request) {
  return wrapWithTimeout(request, "POST", "/api/streams", handleStreamsPost);
}