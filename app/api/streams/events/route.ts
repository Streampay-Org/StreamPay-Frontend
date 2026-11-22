import { NextRequest, NextResponse } from "next/server";
import { db } from "@/app/lib/db";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { authorizeStreamSubscriber, DEFAULT_STREAM_TENANT } from "@/app/lib/stream-subscriber-auth";
import { eventBus } from "@/app/lib/event-bus";
import { logger } from "@/app/lib/logger";
import {
  createSseConnection,
  getSseHeartbeatIntervalMs,
  getSseMaxHeartbeats,
  getSseMaxIdleMs,
  type SseConnection,
} from "@/app/lib/sse";

/**
 * SSE Endpoint for live stream and settlement status updates.
 * 
 * Protocol:
 * - Client connects via GET /api/streams/events?streamId=... with Bearer token.
 * - Server sends "ping" comments every 30s to keep connection alive.
 * - Server sends JSON data for "stream:updated" and "settle:finished" events.
 * 
 * Security:
 * - JWT Authentication required.
 * - Subscribers must be the recipient, sender, an owning-org member, an
 *   administrator, or have a matching non-empty email.
 * - A tenant mismatch returns 404 to avoid exposing stream existence.
 * - x-tenant-id is optional and defaults to "default".
 */
export async function GET(request: NextRequest) {
  // 1. Authenticate Request
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization" } }, { status: 401 });
  }

  // 2. Validate Stream ID
  const { searchParams } = new URL(request.url);
  const streamId = searchParams.get("streamId");

  if (!streamId) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "streamId parameter is required" } }, { status: 422 });
  }

  const stream = db.streams.get(streamId);
  if (!stream) {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Stream not found" } }, { status: 404 });
  }

  const tenant = request.headers.get("x-tenant-id")?.trim() || DEFAULT_STREAM_TENANT;
  const authorization = authorizeStreamSubscriber(actor, stream, tenant);

  if (!authorization.ok) {
    const notFound = authorization.status === 404;
    logger.warn("Unauthorized stream event subscription attempt", {
      actorId: actor.actorId,
      streamId,
      tenant,
      status: authorization.status,
    });
    return NextResponse.json(
      { error: { code: notFound ? "NOT_FOUND" : "FORBIDDEN", message: notFound ? "Stream not found" : "You do not have permission to subscribe to this stream" } },
      { status: authorization.status },
    );
  }

  // 4. Establish SSE Connection
  let sse: SseConnection | undefined;

  const stream_response = new ReadableStream({
    start(controller) {
      logger.info("Client connected to stream events", { actorId: actor.actorId, streamId });

      // Event handlers
      const onStreamUpdated = (data: unknown) => {
        sse?.send("stream:updated", data);
      };

      const onSettleFinished = (data: unknown) => {
        sse?.send("settle:finished", data);
      };

      // Subscribe to event bus
      eventBus.on(`stream:updated:${streamId}`, onStreamUpdated);
      eventBus.on(`settle:finished:${streamId}`, onSettleFinished);

      // Bounded heartbeats + dead-client detection (abort, rejected writes,
      // idle deadline) are handled by the shared SSE connection helper.
      sse = createSseConnection(controller, {
        signal: request.signal,
        heartbeatIntervalMs: getSseHeartbeatIntervalMs(),
        maxHeartbeats: getSseMaxHeartbeats(),
        maxIdleMs: getSseMaxIdleMs(),
        onHeartbeat: (heartbeatsSent) => {
          logger.debug("SSE keep-alive heartbeat sent", {
            actorId: actor.actorId,
            streamId,
            heartbeats_sent: heartbeatsSent,
          });
        },
        onClose: (reason, stats) => {
          eventBus.off(`stream:updated:${streamId}`, onStreamUpdated);
          eventBus.off(`settle:finished:${streamId}`, onSettleFinished);
          logger.info("Client disconnected from stream events", {
            actorId: actor.actorId,
            streamId,
            close_reason: reason,
            events_sent: stats.eventsSent,
            heartbeats_sent: stats.heartbeatsSent,
          });
        },
      });
    },
    cancel() {
      // Consumer cancelled the stream; the helper closes exactly once.
      sse?.close("manual");
    },
  });

  return new Response(stream_response, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
