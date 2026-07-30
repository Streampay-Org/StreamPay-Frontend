import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { extractCorrelationContext, getCorrelationContext, logger, withCorrelationContext } from "@/app/lib/logger";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import type { Stream, StreamStatus } from "@/app/types/openapi";

const ALLOWED_STATUSES: Set<StreamStatus> = new Set([
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
]);

function createErrorResponse(code: string, message: string, status: number, details?: unknown) {
  const context = getCorrelationContext();
  return NextResponse.json(
    {
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
        request_id: context?.request_id,
      },
    },
    { status },
  );
}

function getRequestUrl(request: Request, fallbackPath: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallbackPath}`);
  } catch {
    return new URL(`http://localhost${fallbackPath}`);
  }
}

/**
 * Checks whether a stream matches a full-text search query token set.
 * Matches across: id, recipient, memo, label, email, senderAddress, partnerId, token.
 */
function matchesFullText(stream: Stream, tokens: string[]): boolean {
  if (tokens.length === 0) return true;

  const searchableText = [
    stream.id,
    stream.recipient,
    stream.memo,
    stream.label,
    stream.email,
    stream.senderAddress,
    stream.partnerId,
    stream.token,
  ]
    .filter((val): val is string => typeof val === "string" && val.length > 0)
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => searchableText.includes(token));
}

/**
 * Validates an ISO-8601 date string.
 */
function isValidIsoDate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== "string") return false;
  const timestamp = Date.parse(dateStr);
  if (Number.isNaN(timestamp)) return false;
  // Strict format check for ISO 8601 or YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/i.test(dateStr.trim());
}

export async function GET(request: Request) {
  const url = getRequestUrl(request, "/api/streams/search");
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const rateLimitResult = await checkRateLimit(identity, limitType);

  if (!rateLimitResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    return rateLimitResponse(rateLimitResult.retryAfter!);
  }
  recordRequest(url.pathname);

  const headerContext = extractCorrelationContext(request.headers);
  const correlationContext = {
    correlation_id: headerContext.correlation_id || `api-${crypto.randomUUID()}`,
    request_id: headerContext.request_id || `req-${crypto.randomUUID()}`,
  };

  return withCorrelationContext(correlationContext, async () => {
    const { searchParams } = url;
    const q = searchParams.get("q")?.trim() ?? "";
    const statusParam = searchParams.get("status")?.trim();
    const assetParam = (searchParams.get("asset") ?? searchParams.get("token"))?.trim();
    const senderParam = (searchParams.get("sender") ?? searchParams.get("senderAddress"))?.trim();
    const recipientParam = searchParams.get("recipient")?.trim();
    const fromParam = searchParams.get("from")?.trim();
    const toParam = searchParams.get("to")?.trim();
    const limitRaw = searchParams.get("limit");
    const offsetRaw = searchParams.get("offset");

    // ── Input Validation ──────────────────────────────────────────────
    if (statusParam && !ALLOWED_STATUSES.has(statusParam as StreamStatus)) {
      logger.warn("Stream search validation failed: invalid status", { status: statusParam });
      return createErrorResponse(
        "VALIDATION_ERROR",
        `Invalid status filter '${statusParam}'. Allowed values: ${Array.from(ALLOWED_STATUSES).join(", ")}.`,
        400,
      );
    }

    if (fromParam && !isValidIsoDate(fromParam)) {
      logger.warn("Stream search validation failed: invalid 'from' date", { from: fromParam });
      return createErrorResponse(
        "VALIDATION_ERROR",
        "Invalid 'from' date format. Must be a valid ISO-8601 date string.",
        400,
      );
    }

    if (toParam && !isValidIsoDate(toParam)) {
      logger.warn("Stream search validation failed: invalid 'to' date", { to: toParam });
      return createErrorResponse(
        "VALIDATION_ERROR",
        "Invalid 'to' date format. Must be a valid ISO-8601 date string.",
        400,
      );
    }

    let fromMs: number | undefined;
    if (fromParam) {
      fromMs = Date.parse(fromParam);
    }

    let toMs: number | undefined;
    if (toParam) {
      toMs = Date.parse(toParam);
    }

    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      logger.warn("Stream search validation failed: 'from' date after 'to' date", {
        from: fromParam,
        to: toParam,
      });
      return createErrorResponse(
        "VALIDATION_ERROR",
        "'from' date parameter cannot be after 'to' date parameter.",
        400,
      );
    }

    let limit = 50;
    if (limitRaw !== null) {
      const parsedLimit = Number(limitRaw);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        logger.warn("Stream search validation failed: invalid limit", { limit: limitRaw });
        return createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid 'limit' parameter. Must be an integer between 1 and 200.",
          400,
        );
      }
      limit = parsedLimit;
    }

    let offset = 0;
    if (offsetRaw !== null) {
      const parsedOffset = Number(offsetRaw);
      if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
        logger.warn("Stream search validation failed: invalid offset", { offset: offsetRaw });
        return createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid 'offset' parameter. Must be a non-negative integer.",
          400,
        );
      }
      offset = parsedOffset;
    }

    // ── Execute FTS and Filters ───────────────────────────────────────
    const { streamRepository } = getStore();
    const allStreams: Stream[] = Array.from(streamRepository.streams.values());

    const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];

    let filteredStreams = allStreams.filter((stream) => {
      // Full-text search matching across fields
      if (!matchesFullText(stream, tokens)) {
        return false;
      }

      // Status filter
      if (statusParam && stream.status !== statusParam) {
        return false;
      }

      // Asset / Token filter
      if (assetParam && stream.token.toLowerCase() !== assetParam.toLowerCase()) {
        return false;
      }

      // Sender filter
      if (senderParam && stream.senderAddress?.toLowerCase() !== senderParam.toLowerCase()) {
        return false;
      }

      // Recipient filter (substring or exact)
      if (recipientParam && !stream.recipient.toLowerCase().includes(recipientParam.toLowerCase())) {
        return false;
      }

      // Date range filters (createdAt)
      if (fromMs !== undefined) {
        const streamCreatedMs = Date.parse(stream.createdAt ?? "");
        if (Number.isNaN(streamCreatedMs) || streamCreatedMs < fromMs) {
          return false;
        }
      }

      if (toMs !== undefined) {
        const streamCreatedMs = Date.parse(stream.createdAt ?? "");
        if (Number.isNaN(streamCreatedMs) || streamCreatedMs > toMs) {
          return false;
        }
      }

      return true;
    });

    // Sort by createdAt descending, fallback to id
    filteredStreams.sort((left, right) => {
      const timeCompare = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
      return timeCompare !== 0 ? timeCompare : left.id.localeCompare(right.id);
    });

    const total = filteredStreams.length;
    const paginatedResults = filteredStreams.slice(offset, offset + limit);

    logger.info("Stream search completed successfully", {
      query: q || null,
      status: statusParam || null,
      asset: assetParam || null,
      sender: senderParam || null,
      recipient: recipientParam || null,
      total,
      count: paginatedResults.length,
      limit,
      offset,
    });

    return NextResponse.json({
      data: paginatedResults,
      meta: {
        total,
        limit,
        offset,
        count: paginatedResults.length,
        query: q || null,
      },
      links: {
        self: `/api/streams/search${url.search}`,
      },
    });
  });
}
