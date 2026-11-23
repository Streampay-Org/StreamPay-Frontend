import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import {
  extractCorrelationContext,
  getCorrelationContext,
  logger,
  withCorrelationContext,
} from "@/app/lib/logger";
import { aggregateStreamStats } from "@/app/lib/stream-stats";
import {
  resolveRequestActor,
  resolveRequestTenant,
  visibleTo,
} from "@/app/lib/stream-visibility";
import { observeStreamsRequest } from "@/src/metrics/registry";
import { logAccessEvent } from "@/src/middleware/accessLog";
import { createCacheHeaders, createStrongEtag, isIfNoneMatchMatch } from "@/src/middleware/etag";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { withRouteTimeout } from "@/src/middleware/timeout";

const ROUTE_PATH = "/api/streams/stats";

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id } },
    { status },
  );
}

function durationMsFrom(start: [number, number]): number {
  const [seconds, nanoseconds] = process.hrtime(start);
  return seconds * 1000 + nanoseconds / 1_000_000;
}

function statusToErrorCode(status: number): string {
  switch (status) {
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 429:
      return "rate_limit_exceeded";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : `HTTP_${status}`;
  }
}

function emitAccessEvent(context: {
  method: "GET";
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
}) {
  try {
    logAccessEvent(context);
  } catch (error) {
    logger.warn("Failed to emit access log event", { error });
  }
}

async function handleStreamStatsGet(request: Request): Promise<Response> {
  const start = process.hrtime();
  let status = 200;

  try {
    const rateLimitResult = await streamsRateLimit(request, "GET", ROUTE_PATH);
    if (!rateLimitResult.allowed) {
      status = rateLimitResult.response.status;
      return rateLimitResult.response;
    }

    const { streamRepository } = getStore();
    const tenant = resolveRequestTenant(request);
    const actor = resolveRequestActor(request);
    const isVisible = visibleTo(actor, tenant);

    const tenantCandidates = streamRepository.listByTenant
      ? streamRepository.listByTenant(tenant)
      : Array.from(streamRepository.streams.values());

    const visibleStreams = tenantCandidates.filter(isVisible);
    const stats = aggregateStreamStats(visibleStreams);

    const payload = {
      data: stats,
      links: { self: ROUTE_PATH },
    };

    const etag = createStrongEtag(payload);
    if (isIfNoneMatchMatch(etag, getHeader(request, "if-none-match"))) {
      status = 304;
      return new NextResponse(null, {
        status,
        headers: createCacheHeaders(etag),
      });
    }

    const response = NextResponse.json(payload);
    for (const [name, value] of Object.entries(createCacheHeaders(etag))) {
      response.headers.set(name, value);
    }
    status = 200;
    return response;
  } catch (error) {
    status = 500;
    logger.error("Stream stats failed", { error });
    return createErrorResponse("INTERNAL_ERROR", "Internal Server Error", 500);
  } finally {
    observeStreamsRequest("GET", status, start);
    emitAccessEvent({
      method: "GET",
      path: ROUTE_PATH,
      status,
      durationMs: durationMsFrom(start),
      ...(status >= 400 ? { errorCode: statusToErrorCode(status) } : {}),
    });
  }
}

export async function GET(request: Request): Promise<Response> {
  const start = process.hrtime();
  const run = () =>
    withRouteTimeout(request, async () => {
      const response = await handleStreamStatsGet(request);
      if (response.status === 504) {
        emitAccessEvent({
          method: "GET",
          path: ROUTE_PATH,
          status: response.status,
          durationMs: durationMsFrom(start),
          errorCode: "GATEWAY_TIMEOUT",
        });
      }
      return response;
    });

  if (getCorrelationContext() || !request.headers) return run();
  return withCorrelationContext(extractCorrelationContext(request.headers), run);
}
