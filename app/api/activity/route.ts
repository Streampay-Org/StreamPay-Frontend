import { NextResponse } from "next/server";
import { decodeCompositeCursor, getStore, db } from "@/app/lib/db";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { getCorrelationContext, logger, withCorrelationContext } from "@/app/lib/logger";
import { withRouteTimeout } from "@/src/middleware/timeout";

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

async function handleActivityGet(request: Request) {
  const { activityTimeline } = getStore();
  const url = new URL(request.url);
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const result = await checkRateLimit(identity, limitType);

  if (!result.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(result.retryAfter!);
  }
  recordRequest(url.pathname);

  const { searchParams } = url;
  const cursor = searchParams.get("cursor");
  const streamId = searchParams.get("streamId");
  const type = searchParams.get("type");
  const limit = Math.min(Number.parseInt(searchParams.get("limit") || "20", 10), 100);

  const context = {
    correlation_id: request.headers.get("x-correlation-id") || `api-${crypto.randomUUID()}`,
    request_id: `req-${crypto.randomUUID()}`,
  };

  return withCorrelationContext(context, async () => {
    if (cursor) {
      try {
        decodeCompositeCursor(cursor);
      } catch {
        return createErrorResponse("INVALID_CURSOR", "Malformed cursor", 422);
      }
    }

    const result = activityTimeline.query({ cursor: cursor ?? undefined, limit, streamId: streamId ?? undefined, type: type ?? undefined });

    const tenant = request.headers.get("x-tenant-id");

    const enrichedData = result.data.map(entry => {
      let isDeleted = false;
      if (entry.streamId && tenant) {
        const stream = db.streams.findOne ? db.streams.findOne(tenant, entry.streamId) : null;
        if (!stream) {
          isDeleted = true;
        }
      }
      return {
        ...entry,
        isDeleted
      };
    });

    logger.info("Activity list completed", {
      count: enrichedData.length,
      total: result.meta.total,
      lagMs: activityTimeline.getLagMs(),
    });

    return NextResponse.json({
      data: enrichedData,
      meta: result.meta,
      links: { self: `/api/activity?limit=${limit}` },
    });
  });
}

export async function GET(request: Request) {
  return withRouteTimeout(request, () => handleActivityGet(request));
}
