import { NextResponse } from "next/server";
import { decodeCompositeCursor, getStore } from "@/app/lib/db";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import { getCorrelationContext, logger, withCorrelationContext } from "@/app/lib/logger";
import type { ActivityTimelineEntry } from "@/app/lib/repositories/activity-timeline";
import type { Stream } from "@/app/types/openapi";
import { withRouteSpan } from "@/lib/routeSpan";
import { withRouteTimeout } from "@/src/middleware/timeout";
import { resolveRequestId, isValidRequestId, generateRequestId } from "@/lib/requestId";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STREAM_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Event types the activity feed understands. Rejecting unknown values keeps
 * clients from probing the timeline with arbitrary strings.
 */
const KNOWN_ACTIVITY_EVENT_TYPES = new Set([
  "wallet.connected",
  "wallet.disconnected",
  "stream.created",
  "stream.started",
  "stream.paused",
  "stream.resumed",
  "stream.stopped",
  "stream.settled",
  "stream.ended",
  "stream.cancelled",
  "stream.withdrawn",
  "stream.updated",
  "stream.deleted",
  "funds.withdrawn",
]);

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json({ error: { code, message, request_id: context?.request_id } }, { status });
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) return null;
  return value;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses an ISO date (`YYYY-MM-DD`) or datetime into epoch milliseconds.
 *
 * Date-only values cover the whole UTC day so both range ends stay inclusive:
 * `from` resolves to 00:00:00.000 and `to` to 23:59:59.999 of that date.
 */
function parseDateBoundary(
  raw: string,
  boundary: "start" | "end",
): number | null {
  const value = raw.trim();
  if (value === "") return null;

  if (DATE_ONLY_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const startOfDay = Date.UTC(year, month - 1, day);
    const normalized = new Date(startOfDay);
    // Date.UTC rolls impossible dates over (2026-02-30 becomes March 2).
    if (
      normalized.getUTCFullYear() !== year ||
      normalized.getUTCMonth() !== month - 1 ||
      normalized.getUTCDate() !== day
    ) {
      return null;
    }
    return boundary === "start" ? startOfDay : startOfDay + 86_399_999;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

interface ActivityScope {
  ownsStream(streamId: string): boolean;
  isDeleted(entry: ActivityTimelineEntry): boolean;
  isVisible(entry: ActivityTimelineEntry): boolean;
}

/**
 * Build the caller's visibility scope once per request.
 *
 * Stream events follow the current stream ownership (sender or recipient).
 * Wallet/non-stream events use the actor recorded on the entry. A stream
 * event whose stream record no longer exists falls back to the entry actor,
 * which lets us keep deleted streams visible (flagged `isDeleted`) without
 * asking for the removed row again.
 */
function createActivityScope(
  streams: Iterable<Stream>,
  walletAddress: string,
): ActivityScope {
  const streamsById = new Map<string, Stream>();
  const ownedStreamIds = new Set<string>();

  for (const stream of streams) {
    streamsById.set(stream.id, stream);
    if (stream.senderAddress === walletAddress || stream.recipient === walletAddress) {
      ownedStreamIds.add(stream.id);
    }
  }

  const isVisible = (entry: ActivityTimelineEntry): boolean => {
    if (entry.streamId && streamsById.has(entry.streamId)) {
      return ownedStreamIds.has(entry.streamId);
    }
    return entry.actorAddress === walletAddress;
  };

  return {
    ownsStream: (streamId) => ownedStreamIds.has(streamId),
    isDeleted: (entry) => Boolean(entry.streamId) && !streamsById.has(entry.streamId!),
    isVisible,
  };
}

async function handleActivityGet(request: Request) {
  const store = getStore();
  const { activityTimeline } = store;
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

  const headers = request.headers;
  const request_id = resolveRequestId(headers);
  const rawCorr = headers.get("x-correlation-id");
  const correlation_id =
    rawCorr && isValidRequestId(rawCorr) ? rawCorr : generateRequestId();

  // withRouteSpan installs a correlation context carrying the active span's
  // trace/span ids; propagate them into the request-scoped context.
  const spanContext = getCorrelationContext();
  const context = {
    correlation_id,
    request_id,
    trace_id: spanContext?.trace_id,
    span_id: spanContext?.span_id,
    traceparent: spanContext?.traceparent,
  };

  return withCorrelationContext(context, async () => {
    const actor = tryAuthenticateRequest(request);
    if (!actor) {
      return createErrorResponse(
        "UNAUTHORIZED",
        "Missing or invalid authorization header",
        401,
      );
    }

    const cursor = searchParams.get("cursor");
    const streamId = searchParams.get("streamId");
    const type = searchParams.get("type");
    const limit = parseLimit(searchParams.get("limit"));
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");
    const fromMs =
      fromParam === null ? null : parseDateBoundary(fromParam, "start");
    const toMs = toParam === null ? null : parseDateBoundary(toParam, "end");

    if (limit === null) {
      return createErrorResponse(
        "INVALID_LIMIT",
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
        422,
      );
    }

    if (type !== null && !KNOWN_ACTIVITY_EVENT_TYPES.has(type)) {
      return createErrorResponse(
        "INVALID_TYPE",
        `type must be one of: ${[...KNOWN_ACTIVITY_EVENT_TYPES].join(", ")}`,
        422,
      );
    }

    if (streamId !== null && !STREAM_ID_PATTERN.test(streamId)) {
      return createErrorResponse(
        "INVALID_STREAM_ID",
        "streamId contains invalid characters",
        422,
      );
    }

    if (
      (fromParam !== null && fromMs === null) ||
      (toParam !== null && toMs === null)
    ) {
      return createErrorResponse(
        "INVALID_DATE_RANGE",
        "from and to must be ISO dates (YYYY-MM-DD) or datetimes",
        422,
      );
    }

    if (fromMs !== null && toMs !== null && fromMs > toMs) {
      return createErrorResponse(
        "INVALID_DATE_RANGE",
        "from must be earlier than or equal to to",
        422,
      );
    }

    const matchesDateRange = (entry: ActivityTimelineEntry): boolean => {
      if (fromMs === null && toMs === null) return true;
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isNaN(timestamp)) return false;
      if (fromMs !== null && timestamp < fromMs) return false;
      if (toMs !== null && timestamp > toMs) return false;
      return true;
    };

    const scope = createActivityScope(
      store.streamRepository.streams.values(),
      actor.walletAddress,
    );

    if (streamId !== null && !scope.ownsStream(streamId)) {
      return createErrorResponse("STREAM_NOT_FOUND", `Stream '${streamId}' not found`, 404);
    }

    if (cursor) {
      try {
        decodeCompositeCursor(cursor);
      } catch {
        return createErrorResponse("INVALID_CURSOR", "Malformed cursor", 422);
      }
    }

    const queryResult = activityTimeline.query({
      cursor: cursor ?? undefined,
      limit,
      streamId: streamId ?? undefined,
      type: type ?? undefined,
      predicate: (entry) => scope.isVisible(entry) && matchesDateRange(entry),
    });

    const enrichedData = queryResult.data.map((entry) => ({
      ...entry,
      isDeleted: scope.isDeleted(entry),
    }));

    logger.info("Activity list completed", {
      count: enrichedData.length,
      total: queryResult.meta.total,
      lagMs: activityTimeline.getLagMs(),
    });

    return NextResponse.json({
      data: enrichedData,
      meta: queryResult.meta,
      links: { self: `/api/activity?limit=${limit}` },
    });
  });
}

export async function GET(request: Request) {
  return withRouteSpan("/api/activity", () =>
    withRouteTimeout(request, () => handleActivityGet(request)),
  )(request);
}
