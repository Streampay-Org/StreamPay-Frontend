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
import { logAccessEvent } from "@/src/middleware/accessLog";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { checkTokenAllowed, normaliseToken } from "@/app/lib/token-allowlist";
import {
  validateCreateStreamBody,
  validateListStreamsQuery,
} from "@/app/lib/stream-validation";
import type { Stream } from "@/app/types/openapi";
import { createCacheHeaders, createStrongEtag, isIfNoneMatchMatch } from "@/src/middleware/etag";
import { observeStreamsRequest } from "@/src/metrics/registry";

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

export async function GET(request: Request) {
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

export async function POST(request: Request) {
  const start = process.hrtime();
  let status = 201;

  try {
    const { idempotencyStore, streamRepository } = getStore();
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

    // ── Schema validation (shared) ────────────────────────────────────────
    const validationErrors = validateCreateStreamBody(body);
    if (validationErrors.length > 0) {
      status = 422;
      logger.warn("Stream creation validation failed", {
        errors: validationErrors,
      });
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "One or more fields are invalid.",
            details: validationErrors,
            request_id: getCorrelationContext()?.request_id,
          },
        },
        { status },
      );
    }

    const { rate, recipient, schedule, token: rawToken } = body as {
      rate?: string;
      recipient?: string;
      schedule?: string;
      token?: string;
    };

    const rateValue = rate ?? "";
    const recipientValue = recipient ?? "";
    const scheduleValue = schedule ?? "";
    const tokenStr = rawToken?.trim() || "XLM";
    let normalisedToken: string;
    try {
      normalisedToken = normaliseToken(tokenStr);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      status = 422;
      return createErrorResponse("INVALID_TOKEN", `Invalid token format: ${msg}`, 422);
    }

    const allowlistResult = await checkTokenAllowed(normalisedToken);
    if (!allowlistResult.accepted) {
      status = 422;
      logger.warn("Stream creation rejected: token not in allowlist", { token: normalisedToken });
      return createErrorResponse("TOKEN_NOT_ALLOWED", allowlistResult.reason, 422);
    }

    const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const newStream: Stream = {
      createdAt: now,
      id,
      nextAction: "start",
      rate: rateValue,
      recipient: recipientValue,
      schedule: scheduleValue,
      status: "draft",
      updatedAt: now,
      token: normalisedToken,
    };

    streamRepository.streams.set(id, newStream);
    const payload = { data: newStream, links: { self: `/api/v1/streams/${id}` } };

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
