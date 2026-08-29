import { NextRequest, NextResponse } from "next/server";
import { db, getStore } from "@/app/lib/db";
import { tryAuthenticateRequest, JWT_SECRET } from "@/app/lib/auth";
import { eventBus } from "@/app/lib/event-bus";
import { logger, getCorrelationContext, extractCorrelationContext, setCorrelationContext, withStreamContext } from "@/app/lib/logger";
import {
  SseQueue,
  encodeSSEFrame,
  encodeSSEComment,
  flushQueue,
  sseMetricsLog,
} from "@/lib/sseBackpressure";

type Context = { params: Promise<{ id: string }> };

/**
 * SSE Endpoint for live stream deltas via Server-Sent Events.
 * 
 * Route: GET /api/streams/:id/events
 * 
 * Protocol:
 * - Client connects via GET /api/streams/:id/events with Bearer token.
 * - Server sends "ping" comments every 30s to keep connection alive.
 * - Server sends JSON data for "stream:updated" and "settle:finished" events.
 * 
 * Security:
 * - JWT Authentication required.
 * - Users can only subscribe to streams they own (recipient or matching email).
 * - 403 returned on unauthorized access or ID guessing.
 * 
 * Headers:
 * - Authorization: Bearer <JWT token>
 * - x-correlation-id: Optional correlation ID for tracing
 * - x-tenant-id: Required tenant ID header
 * 
 * Response Headers:
 * - Content-Type: text/event-stream
 * - Cache-Control: no-cache, no-transform
 * - Connection: keep-alive
 * - x-request-id: Request ID for tracing
 * - x-correlation-id: Correlation ID for tracing
 */
export async function GET(
  request: NextRequest,
  { params }: Context
) {
  // Extract and set correlation context from headers
  const correlationContext = extractCorrelationContext(request.headers);
  setCorrelationContext(correlationContext);
  
  const { id: streamId } = await params;
  
  // Add stream ID to correlation context
  withStreamContext(streamId);
  
  // 1. Authenticate Request
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    logger.warn("SSE connection attempt without valid authentication", {
      streamId,
      ip: request.headers.get("x-forwarded-for") || "unknown",
    });
    return NextResponse.json(
      { 
        error: { 
          code: "UNAUTHORIZED", 
          message: "Missing or invalid authorization header",
          request_id: getCorrelationContext()?.request_id 
        } 
      }, 
      { status: 401 }
    );
  }

  // 2. Validate Stream ID format
  if (!streamId || typeof streamId !== "string" || streamId.trim() === "") {
    logger.warn("Invalid stream ID in SSE request", {
      streamId,
      actorId: actor.actorId,
    });
    return NextResponse.json(
      { 
        error: { 
          code: "VALIDATION_ERROR", 
          message: "Stream ID is required and must be a non-empty string",
          request_id: getCorrelationContext()?.request_id 
        } 
      }, 
      { status: 422 }
    );
  }

  // 3. Validate Tenant ID
  const tenant = request.headers.get("x-tenant-id");
  if (!tenant || tenant.trim() === "") {
    logger.warn("Missing tenant ID in SSE request", {
      streamId,
      actorId: actor.actorId,
    });
    return NextResponse.json(
      { 
        error: { 
          code: "MISSING_TENANT", 
          message: "Tenant ID header (x-tenant-id) is required",
          request_id: getCorrelationContext()?.request_id 
        } 
      }, 
      { status: 400 }
    );
  }

  // 4. Fetch Stream
  const { streamRepository } = getStore();
  const stream = streamRepository.streams.get(streamId);
  
  if (!stream) {
    logger.warn("Stream not found for SSE connection", {
      streamId,
      tenant,
      actorId: actor.actorId,
    });
    return NextResponse.json(
      { 
        error: { 
          code: "NOT_FOUND", 
          message: `Stream '${streamId}' not found`,
          request_id: getCorrelationContext()?.request_id 
        } 
      }, 
      { status: 404 }
    );
  }

  // 5. Authorization Check
  // Users can only subscribe to streams where they are the recipient
  // or if they have admin role
  const isOwner = 
    (stream as any).recipient === actor.walletAddress || 
    (stream as any).email && (db.users.get(actor.walletAddress)?.email === (stream as any).email) ||
    actor.role === "admin";

  if (!isOwner) {
    logger.warn("Unauthorized SSE subscription attempt", {
      actorId: actor.actorId,
      streamId,
      tenant,
      walletAddress: actor.walletAddress,
    });
    return NextResponse.json(
      { 
        error: { 
          code: "FORBIDDEN", 
          message: "You do not have permission to subscribe to this stream",
          request_id: getCorrelationContext()?.request_id 
        } 
      }, 
      { status: 403 }
    );
  }

  // 6. Establish SSE Connection with backpressure queue
  //
  // Event-bus callbacks are not bound by any flow-control primitive, so a
  // slow client can cause the in-process queue to grow without bound.  We
  // route every frame through a bounded SseQueue; overflow events are
  // dropped (or handled per the configured policy) and logged so operators
  // can diagnose slow-consumer problems without OOM crashes.
  const encoder = new TextEncoder();

  // Queue capacity: default 64 frames (~20 min of 30 s ping intervals).
  const sseQueue = new SseQueue({ capacity: 64, policy: "drop" });

  logger.info("SSE connection established", {
    actorId: actor.actorId,
    streamId,
    tenant,
    walletAddress: actor.walletAddress,
  });

  /**
   * Enqueue an SSE event frame through the backpressure queue, then flush
   * to the controller.  Returns `false` if the controller is closed.
   */
  const sendEvent = (
    controller: ReadableStreamDefaultController,
    eventName: string,
    data: unknown,
  ): boolean => {
    const chunk = encodeSSEFrame(encoder, eventName, data);
    const result = sseQueue.enqueue(chunk);

    if (result === "dropped") {
      logger.warn("SSE stream: event dropped due to queue overflow", sseMetricsLog(
        sseQueue.metrics(),
        { streamId, actorId: actor.actorId, event: eventName },
      ));
    } else if (result === "backpressured") {
      logger.warn("SSE stream: queue backpressure detected", sseMetricsLog(
        sseQueue.metrics(),
        { streamId, actorId: actor.actorId, event: eventName },
      ));
    } else if (result === "evicted") {
      logger.warn("SSE stream: oldest event evicted from queue (newest policy)", sseMetricsLog(
        sseQueue.metrics(),
        { streamId, actorId: actor.actorId, event: eventName },
      ));
    } else if (result === "error") {
      logger.error("SSE stream: queue overflow (error policy) — closing stream", sseMetricsLog(
        sseQueue.metrics(),
        { streamId, actorId: actor.actorId, event: eventName },
      ));
      flushQueue(sseQueue, controller);
      try { controller.close(); } catch { /* already closed */ }
      return false;
    }

    return flushQueue(sseQueue, controller) !== "closed";
  };

  let cleanupFn: (() => void) | undefined;

  const streamResponse = new ReadableStream({
    start(controller) {
      let isClosed = false;
      let pingInterval: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (isClosed) {
          return;
        }

        isClosed = true;

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = undefined;
        }

        eventBus.off(`stream:updated:${streamId}`, onStreamUpdated);
        eventBus.off(`settle:finished:${streamId}`, onSettleFinished);
        request.signal.removeEventListener("abort", onAbort);

        const finalMetrics = sseQueue.metrics();
        logger.info("SSE connection closed", sseMetricsLog(
          finalMetrics,
          { actorId: actor.actorId, streamId, tenant },
        ));

        try {
          controller.close();
        } catch (e) {
          // Stream might already be closed
        }
      };
      cleanupFn = cleanup;

      const onAbort = () => cleanup();

      // Keep-alive ping interval (every 30 seconds)
      // Pings are also routed through the queue so slow consumers see them
      // without ever bypassing the backpressure boundary.
      pingInterval = setInterval(() => {
        if (isClosed) {
          return;
        }
        const pingChunk = encodeSSEComment(encoder, "keep-alive");
        const pingResult = sseQueue.enqueue(pingChunk);
        if (pingResult === "dropped" || pingResult === "error") {
          // Ping dropped; if queue is in error state, trigger cleanup.
          if (pingResult === "error") {
            logger.warn("SSE stream: keep-alive dropped (error policy triggered)", {
              streamId,
              actorId: actor.actorId,
            });
            cleanup();
            return;
          }
        }
        if (flushQueue(sseQueue, controller) === "closed") {
          cleanup();
        }
      }, 30000);

      // Event handlers for stream updates
      const onStreamUpdated = (data: unknown) => {
        if (isClosed) {
          return;
        }

        const ok = sendEvent(controller, "stream:updated", data);
        if (!ok) {
          logger.error("SSE stream: stream:updated could not be delivered — closing", {
            streamId,
            actorId: actor.actorId,
          });
          cleanup();
        } else {
          logger.debug("SSE: stream:updated event sent", {
            streamId,
            actorId: actor.actorId,
          });
        }
      };

      const onSettleFinished = (data: unknown) => {
        if (isClosed) {
          return;
        }

        const ok = sendEvent(controller, "settle:finished", data);
        if (!ok) {
          logger.error("SSE stream: settle:finished could not be delivered — closing", {
            streamId,
            actorId: actor.actorId,
          });
          cleanup();
        } else {
          logger.debug("SSE: settle:finished event sent", {
            streamId,
            actorId: actor.actorId,
          });
        }
      };

      // Subscribe to event bus for this specific stream
      eventBus.on(`stream:updated:${streamId}`, onStreamUpdated);
      eventBus.on(`settle:finished:${streamId}`, onSettleFinished);

      // Handle stream termination on client disconnect
      request.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      cleanupFn?.();
      logger.info("SSE connection cancelled", {
        streamId,
        actorId: actor.actorId,
      });
    }
  });

  return new Response(streamResponse, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Request-ID": getCorrelationContext()?.request_id || "",
      "X-Correlation-ID": getCorrelationContext()?.correlation_id || "",
    },
  });
}
