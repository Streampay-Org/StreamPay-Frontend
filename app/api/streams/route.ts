import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  decodeCursor,
  encodeCursor,
  getStore,
  idempotencyToken,
  setIdempotency,
} from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import {
  validateListStreamsQuery,
} from "@/app/lib/stream-validation";
import { createCacheHeaders, createStrongEtag, isIfNoneMatchMatch } from "@/src/middleware/etag";
import { observeStreamsRequest } from "@/src/metrics/registry";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { createStreamCore } from "@/app/lib/stream-create-core";

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

    let streams = Array.from(streamRepository.streams.values()).sort((left, right) => {
      const timeCompare = left.createdAt.localeCompare(right.createdAt);
      return timeCompare !== 0 ? timeCompare : left.id.localeCompare(right.id);
    });

    if (streamStatus) {
      streams = streams.filter((stream) => stream.status === streamStatus);
    }

    if (cursor) {
      let cursorId: string;
      try {
        cursorId = decodeCursor(cursor);
      } catch {
        status = 422;
        return errorResponse("INVALID_CURSOR", "Malformed cursor", 422);
      }
      const cursorIndex = streams.findIndex((stream) => stream.id === cursorId);
      if (cursorIndex >= 0) {
        streams = streams.slice(cursorIndex + 1);
      }
    }

    const paginatedStreams = streams.slice(0, limit);
    const hasNext = streams.length > limit;
    const nextCursor =
      hasNext && paginatedStreams.length > 0
        ? encodeCursor(paginatedStreams[paginatedStreams.length - 1].id)
        : null;

    const payload = {
      data: paginatedStreams,
      links: { self: `/api/v1/streams?limit=${limit}` },
      meta: { hasNext, nextCursor, total: streams.length },
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
      total: streamRepository.streams.size,
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
  }
}

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleStreamsGet(request));
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

    const result = await createStreamCore(body, { dryRun: false });
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
  }
}

export async function POST(request: Request) {
  return withRouteTimeout(request, () => handleStreamsPost(request));
}
