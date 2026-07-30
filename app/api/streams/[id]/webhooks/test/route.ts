/**
 * POST /api/streams/:id/webhooks/test
 *
 * Triggers a synthetic webhook event for a stream to allow subscribers to
 * verify their webhook endpoint configuration is working correctly.
 *
 * When `endpoint_url` is supplied the synthetic event is dispatched to that
 * URL through the standard delivery pipeline (HMAC-signed, circuit-breaker
 * protected).  Without `endpoint_url` the endpoint returns a preview payload
 * only — useful for integration-test scaffolding.
 *
 * ## Request body (optional)
 * ```json
 * {
 *   "event_type": "stream.updated",
 *   "endpoint_url": "https://example.com/webhooks"
 * }
 * ```
 *
 * ## Response (202 Accepted)
 * ```json
 * {
 *   "data": {
 *     "delivery_id": "wh_test_01HZ...",
 *     "stream_id": "stream_abc",
 *     "event_type": "stream.test",
 *     "dispatched_at": "2024-01-01T00:00:00.000Z",
 *     "synthetic": true,
 *     "delivery": { "success": true, "status_code": 200 }
 *   }
 * }
 * ```
 *
 * ## Error codes
 * | Status | Code               | Reason                                   |
 * |--------|--------------------|------------------------------------------|
 * | 400    | `BAD_REQUEST`      | Invalid JSON body or unknown event type. |
 * | 404    | `STREAM_NOT_FOUND` | Stream does not exist.                   |
 * | 429    | `rate_limit_exceeded` | Too many test requests.               |
 * | 500    | `INTERNAL_SERVER_ERROR` | Dispatch failed.                   |
 */

import { NextResponse } from "next/server";
import { db } from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import {
  webhookDeliveryClient,
  type WebhookEndpoint,
  type WebhookEvent,
} from "@/app/lib/webhook-delivery";
import {
  checkRateLimit,
  getClientIdentity,
  rateLimitResponse,
} from "@/app/lib/rate-limit";

/** Allowed synthetic event types that subscribers can test against. */
const ALLOWED_EVENT_TYPES = new Set([
  "stream.test",
  "stream.created",
  "stream.updated",
  "stream.paused",
  "stream.resumed",
  "stream.stopped",
  "stream.cancelled",
  "stream.settled",
]);

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id } },
    { status },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // ── Rate limit ────────────────────────────────────────────────────────────
  const identity = getClientIdentity(req);
  const rlResult = await checkRateLimit(identity, "write");
  if (!rlResult.allowed) {
    return rateLimitResponse(rlResult.retryAfter!);
  }

  // ── Validate stream exists ────────────────────────────────────────────────
  const stream = db.streams.get(id);
  if (!stream) {
    return createErrorResponse(
      ErrorCode.STREAM_NOT_FOUND,
      `Stream '${id}' not found`,
      404,
    );
  }

  // ── Parse optional body ───────────────────────────────────────────────────
  let eventType = "stream.test";
  let endpointUrl: string | undefined;

  if (req.headers.get("content-length") !== "0") {
    try {
      const body = await req.text();
      if (body.trim()) {
        const parsed = JSON.parse(body) as Record<string, unknown>;

        if (parsed.event_type !== undefined) {
          if (typeof parsed.event_type !== "string") {
            return createErrorResponse(
              ErrorCode.BAD_REQUEST,
              "'event_type' must be a string.",
              400,
            );
          }
          if (!ALLOWED_EVENT_TYPES.has(parsed.event_type)) {
            return createErrorResponse(
              ErrorCode.BAD_REQUEST,
              `Unknown event_type '${parsed.event_type}'. Allowed: ${[...ALLOWED_EVENT_TYPES].join(", ")}.`,
              400,
            );
          }
          eventType = parsed.event_type;
        }

        if (parsed.endpoint_url !== undefined) {
          if (typeof parsed.endpoint_url !== "string") {
            return createErrorResponse(
              ErrorCode.BAD_REQUEST,
              "'endpoint_url' must be a string.",
              400,
            );
          }
          try {
            const parsedUrl = new URL(parsed.endpoint_url);
            if (
              parsedUrl.protocol !== "https:" &&
              parsedUrl.protocol !== "http:"
            ) {
              return createErrorResponse(
                ErrorCode.BAD_REQUEST,
                "'endpoint_url' must use http: or https: protocol.",
                400,
              );
            }
          } catch {
            return createErrorResponse(
              ErrorCode.BAD_REQUEST,
              "'endpoint_url' is not a valid URL.",
              400,
            );
          }
          endpointUrl = parsed.endpoint_url;
        }
      }
    } catch {
      return createErrorResponse(
        ErrorCode.BAD_REQUEST,
        "Request body must be valid JSON.",
        400,
      );
    }
  }

  const correlationCtx = getCorrelationContext();
  const deliveryId = `wh_test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const dispatchedAt = new Date().toISOString();
  const eventId = `evt_test_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // ── Build synthetic event ─────────────────────────────────────────────────
  const syntheticEvent: WebhookEvent = {
    id: eventId,
    eventType,
    streamId: id,
    timestamp: dispatchedAt,
    data: {
      stream_id: id,
      status: stream.status,
      synthetic: true,
    },
  };

  // ── Dispatch (only when an endpoint_url is provided) ──────────────────────
  let delivery:
    | { success: boolean; status_code?: number; error?: string }
    | undefined;

  if (endpointUrl) {
    const endpoint: WebhookEndpoint = {
      id: `wh_test_endpoint_${deliveryId}`,
      url: endpointUrl,
      maxRetries: 0,
    };

    try {
      const result = await webhookDeliveryClient.attemptDelivery(
        endpoint,
        syntheticEvent,
        deliveryId,
        1,
      );
      delivery = {
        success: result.success,
        status_code: result.statusCode,
        error: result.error,
      };

      if (result.success) {
        logger.info("Synthetic webhook dispatched successfully", {
          action: "webhooks.test",
          delivery_id: deliveryId,
          endpoint_url: endpointUrl,
          event_type: eventType,
          status_code: result.statusCode,
          stream_id: id,
        });
      } else {
        logger.warn("Synthetic webhook dispatch failed", {
          action: "webhooks.test",
          delivery_id: deliveryId,
          endpoint_url: endpointUrl,
          error: result.error,
          status_code: result.statusCode,
          stream_id: id,
        });
      }
    } catch (err) {
      delivery = {
        success: false,
        error: err instanceof Error ? err.message : "Unknown dispatch error",
      };
      logger.warn("Synthetic webhook dispatch threw", {
        action: "webhooks.test",
        delivery_id: deliveryId,
        endpoint_url: endpointUrl,
        error: delivery.error,
        stream_id: id,
      });
    }
  }

  // ── Response ──────────────────────────────────────────────────────────────
  const syntheticPayload = {
    delivery_id: deliveryId,
    stream_id: id,
    event_type: eventType,
    dispatched_at: dispatchedAt,
    synthetic: true,
    request_id: correlationCtx?.request_id,
    data: {
      stream_id: id,
      status: stream.status,
    },
    ...(delivery ? { delivery } : {}),
  };

  logger.info("Synthetic webhook test event dispatched", {
    action: "webhooks.test",
    delivery_id: deliveryId,
    event_type: eventType,
    has_endpoint: !!endpointUrl,
    stream_id: id,
    request_id: correlationCtx?.request_id,
  });

  return NextResponse.json({ data: syntheticPayload }, { status: 202 });
}
