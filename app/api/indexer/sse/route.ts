/**
 * GET /api/indexer/sse
 *
 * Server-Sent Events endpoint for live indexer status.
 *
 * Streams `indexer_status` events every SSE_INTERVAL_MS (default 5 s) until
 * the client disconnects or the server reaches MAX_EVENTS (default 720, i.e.
 * ~1 hour at 5 s cadence). An initial snapshot is emitted immediately so the
 * client never has to wait for the first tick.
 *
 * ## Backpressure & queue overflow
 * Events are staged through a bounded `SseQueue` before being forwarded to the
 * `ReadableStream` controller.  When the queue fills faster than the client
 * drains it:
 * - The excess event is dropped and its count is recorded in queue metrics.
 * - A warning is logged at the `backpressured` threshold (75 % of capacity).
 * - The total drop count is returned in `X-SSE-Queue-Dropped` on stream close.
 *
 * The queue capacity and overflow policy can be tuned via env vars:
 * - `SSE_QUEUE_CAPACITY` — max buffered frames (default 64).
 * - `SSE_QUEUE_POLICY`   — `"drop"` | `"newest"` | `"error"` (default `"drop"`).
 *
 * ## Usage
 * ```ts
 * const es = new EventSource('/api/indexer/sse');
 * es.addEventListener('indexer_status', (e) => {
 *   const status = JSON.parse(e.data);
 *   console.log(status.ledgerCursor, status.lagMs);
 * });
 * es.addEventListener('error', (e) => es.close());
 * ```
 *
 * ## Security
 * - Rate-limited to the "read" bucket (60 req/min per identity).
 * - Correlation context (request_id, correlation_id) is attached to every
 *   structured log line for distributed-tracing support.
 * - When the indexer circuit breaker is open the stream immediately emits a
 *   single `indexer_status` event with `breakerOpen: true` and closes cleanly,
 *   rather than continuing to poll frozen state indefinitely.
 *
 * ## Response headers
 * | Header                | Value                           |
 * |-----------------------|---------------------------------|
 * | Content-Type          | text/event-stream               |
 * | Cache-Control         | no-cache, no-transform          |
 * | Connection            | keep-alive                      |
 * | X-Accel-Buffering     | no                              |
 * | X-Request-Id          | <correlation request_id>        |
 * | X-SSE-Queue-Capacity  | <queue capacity>                |
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { isCircuitBreakerOpen } from "@/app/lib/admin-guard";
import { checkRateLimit, getClientIdentity, rateLimitResponse } from "@/app/lib/rate-limit";
import { getLimitForRoute } from "@/app/lib/rate-limit-config";
import { recordRequest, recordThrottle } from "@/app/lib/rate-limit-metrics";
import {
  extractCorrelationContext,
  logger,
  withCorrelationContext,
} from "@/app/lib/logger";
import {
  SseQueue,
  flushQueue,
  sseMetricsLog,
} from "@/lib/sseBackpressure";
import type { SseOverflowPolicy } from "@/lib/sseBackpressure";

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------


/**
 * Milliseconds between status ticks.
 * Read per-request so that tests can override via `process.env.SSE_INTERVAL_MS`
 * without needing to re-import the module.
 */
function getSseIntervalMs(): number {
  return Number(process.env.SSE_INTERVAL_MS ?? 5_000);
}

/**
 * Maximum number of events emitted per connection.
 * Read per-request so tests can set `process.env.SSE_MAX_EVENTS` freely.
 * At the default 5 s interval, 720 events ≈ 1 hour.
 */
function getMaxEvents(): number {
  return Number(process.env.SSE_MAX_EVENTS ?? 720);
}

/**
 * Maximum number of frames the backpressure queue can hold before the
 * overflow policy is applied.  Read per-request so tests can override via
 * `process.env.SSE_QUEUE_CAPACITY`.
 */
function getQueueCapacity(): number {
  return Number(process.env.SSE_QUEUE_CAPACITY ?? 64);
}

/**
 * Backpressure queue overflow policy.
 * Read per-request so tests can set `process.env.SSE_QUEUE_POLICY` freely.
 */
function getQueuePolicy(): SseOverflowPolicy {
  const raw = process.env.SSE_QUEUE_POLICY ?? "drop";
  if (raw === "drop" || raw === "newest" || raw === "error") {
    return raw;
  }
  return "drop";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of each `indexer_status` SSE payload. */
export interface IndexerStatus {
  /** Latest processed ledger sequence number. */
  ledgerCursor: number;
  /** Milliseconds behind the Horizon tip. */
  lagMs: number;
  /** Number of ledgers queued for processing. */
  queueDepth: number;
  /** ISO-8601 timestamp of this snapshot. */
  syncedAt: string;
  /**
   * `true` when an admin has tripped the indexer circuit breaker via
   * `POST /api/admin/circuit-breaker`.  When open, ingestion is halted;
   * cursor and lag are frozen at their last values.
   */
  breakerOpen: boolean;
}

// ---------------------------------------------------------------------------
// Status sampling
// ---------------------------------------------------------------------------

/**
 * Returns a current snapshot of indexer state.
 *
 * In production this would read from the real indexer state store (e.g. a
 * Redis key or an in-process singleton updated by the HorizonIndexer worker).
 * The stub here generates plausible values so the SSE wire-format can be
 * exercised end-to-end without a live Horizon connection.
 */
export function getIndexerStatus(): IndexerStatus {
  return {
    ledgerCursor: 50_000_000 + Math.floor(Math.random() * 1_000),
    lagMs: Math.floor(Math.random() * 3_000),
    queueDepth: Math.floor(Math.random() * 50),
    syncedAt: new Date().toISOString(),
    breakerOpen: isCircuitBreakerOpen("indexer"),
  };
}

// ---------------------------------------------------------------------------
// SSE frame helpers (delegated to lib/sseBackpressure)
// ---------------------------------------------------------------------------

/**
 * Encodes a named SSE event frame.
 *
 * Format per the HTML living standard:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 */
function encodeEvent(encoder: TextEncoder, event: string, data: unknown, id?: string): Uint8Array {
  let output = `event: ${event}\n`;
  if (id) {
    output += `id: ${id}\n`;
  }
  output += `data: ${JSON.stringify(data)}\n\n`;
  return encoder.encode(output);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/indexer/sse
 *
 * Applies rate-limiting, sets up a correlation context, then opens an SSE
 * stream that continuously emits `indexer_status` events.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // ── Rate limiting ────────────────────────────────────────────────────────
  const limitType = getLimitForRoute("GET", url.pathname);
  const identity = getClientIdentity(request);
  const rateResult = await checkRateLimit(identity, limitType);

  if (!rateResult.allowed) {
    recordThrottle(url.pathname, limitType, identity.type, identity.displayValue);
    // rateLimitResponse returns a NextResponse; we need a plain Response for
    // the SSE path, but the rate-limit rejection is not SSE so NextResponse is fine.
    return rateLimitResponse(rateResult.retryAfter!) as unknown as Response;
  }

  recordRequest(url.pathname);

  // ── Correlation context ──────────────────────────────────────────────────
  const correlationCtx = extractCorrelationContext(request.headers);

  return withCorrelationContext(correlationCtx, async () => {
    logger.info("SSE indexer stream opened", {
      identity_type: identity.type,
      identity: identity.displayValue,
    });

    const encoder = new TextEncoder();

    // ── Backpressure queue ─────────────────────────────────────────────────
    // All SSE frames pass through this bounded queue before reaching the
    // ReadableStream controller.  If the client is slow, the queue absorbs
    // the burst up to `capacity` and then applies the configured overflow
    // policy (default: drop + log).  This prevents unbounded memory growth
    // on long-lived connections with slow consumers.
    const sseQueue = new SseQueue({
      capacity: getQueueCapacity(),
      policy: getQueuePolicy(),
    });

    const stream = new ReadableStream({
      async start(controller) {
        let lastSentId = request.headers.get("last-event-id") ?? request.headers.get("Last-Event-ID") ?? null;

        /**
         * Stage one encoded SSE frame through the backpressure queue, then
         * immediately flush the queue into `controller`.
         *
         * @returns `false` when the controller is already closed (client gone)
         *          so callers can break out of their loop early.
         */
        const send = (event: string, data: unknown): boolean => {
          const id = crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
          
          if (id === lastSentId) {
            return true; // Skip duplicate status
          }
          
          lastSentId = id;
          const chunk = encodeEvent(encoder, event, data, id);
          const result = sseQueue.enqueue(chunk);

          if (result === "dropped") {
            logger.warn("SSE indexer: event dropped due to queue overflow", sseMetricsLog(
              sseQueue.metrics(),
              { request_id: correlationCtx.request_id },
            ));
            // The queue still has items — try to flush what we have.
          } else if (result === "backpressured") {
            logger.warn("SSE indexer: queue backpressure detected", sseMetricsLog(
              sseQueue.metrics(),
              { request_id: correlationCtx.request_id },
            ));
          } else if (result === "error") {
            // Terminal overflow — close the stream cleanly.
            logger.error("SSE indexer: queue overflow (error policy) — closing stream", sseMetricsLog(
              sseQueue.metrics(),
              { request_id: correlationCtx.request_id },
            ));
            flushQueue(sseQueue, controller);
            try { controller.close(); } catch { /* already closed */ }
            return false;
          } else if (result === "evicted") {
            logger.warn("SSE indexer: oldest event evicted from queue (newest policy)", sseMetricsLog(
              sseQueue.metrics(),
              { request_id: correlationCtx.request_id },
            ));
          }

          // Flush the queue to the wire.
          const flushed = flushQueue(sseQueue, controller);
          if (flushed === "closed") {
            // Controller already closed — client has disconnected.
            return false;
          }
          return true;
        };

        // Emit initial snapshot immediately so the client has data right away.
        const initial = getIndexerStatus();
        if (!send("indexer_status", initial)) {
          return;
        }

        // If the breaker is already open on connect, emit one event and close.
        // No point in polling frozen state for an hour.
        if (initial.breakerOpen) {
          logger.warn("SSE indexer stream: circuit breaker open on connect, closing early", {
            request_id: correlationCtx.request_id,
          });
          controller.close();
          return;
        }

        // Poll loop — runs until MAX_EVENTS, client disconnect, or breaker trips.
        let emitted = 1; // we already sent the initial snapshot
        while (emitted < getMaxEvents()) {
          await new Promise<void>((resolve) => setTimeout(resolve, getSseIntervalMs()));

          const status = getIndexerStatus();
          if (!send("indexer_status", status)) {
            // Client disconnected or terminal overflow mid-stream.
            logger.info("SSE indexer stream: client disconnected", sseMetricsLog(
              sseQueue.metrics(),
              { events_emitted: emitted, request_id: correlationCtx.request_id },
            ));
            return;
          }

          emitted++;

          // Trip detected mid-stream: emit the breaker-open state and exit
          // cleanly so the client can reconnect when the breaker is reset.
          if (status.breakerOpen) {
            logger.warn("SSE indexer stream: circuit breaker tripped, closing stream", sseMetricsLog(
              sseQueue.metrics(),
              { events_emitted: emitted, request_id: correlationCtx.request_id },
            ));
            break;
          }
        }

        const finalMetrics = sseQueue.metrics();
        logger.info("SSE indexer stream closed", sseMetricsLog(
          finalMetrics,
          { events_emitted: emitted, request_id: correlationCtx.request_id },
        ));

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Request-Id": correlationCtx.request_id,
        "X-SSE-Queue-Capacity": String(getQueueCapacity()),
      },
    });
  });
}
