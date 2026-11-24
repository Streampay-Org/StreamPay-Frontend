/**
 * @module sseBackpressure
 *
 * Backpressure and queue-overflow management for Server-Sent Event streams.
 *
 * ## Problem solved
 * The WHATWG `ReadableStream` controller that backs SSE responses does not
 * surface how many bytes are buffered in the browser's receive window or in
 * any reverse-proxy buffer between the server and the client.  If the server
 * enqueues faster than the client consumes, the in-process queue grows
 * without bound — eventually causing an OOM condition or silent event loss.
 *
 * ## Design
 * `SseQueue` is a **bounded, in-process FIFO** that sits between the producer
 * (poll loop / event-bus listener) and the `ReadableStream` controller.
 * The queue exposes three overflow policies:
 *
 * | Policy      | When queue is full…                                  |
 * | ----------- | ---------------------------------------------------- |
 * | `"drop"`    | The incoming event is silently discarded.            |
 * | `"error"`   | The stream is closed with a terminal error frame.   |
 * | `"newest"`  | The oldest un-sent event is evicted to make room.   |
 *
 * Every overflow is counted in `SseQueueMetrics` so it can be surfaced in
 * logs, metrics dashboards, or a dedicated `X-SSE-Dropped` response trailer.
 *
 * ## Backpressure signal
 * When the queue reaches `highWaterMark` (default: 75 % of `capacity`)
 * `isBackpressured()` returns `true`.  Producers should slow down or skip
 * non-critical events while this flag is set.
 *
 * ## Usage
 * ```ts
 * const q = new SseQueue({ capacity: 64, policy: "drop" });
 *
 * // Producer side (poll loop / event-bus listener):
 * if (!q.enqueue(event)) {
 *   logger.warn("SSE queue overflow — event dropped", q.metrics());
 * }
 *
 * // Consumer side (ReadableStream start callback):
 * const flush = async (controller: ReadableStreamDefaultController) => {
 *   for (const chunk of q.drain()) {
 *     controller.enqueue(chunk);
 *   }
 * };
 * ```
 *
 * @see {@link SseQueue}
 * @see {@link SseQueueOptions}
 * @see {@link SseQueueMetrics}
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Overflow strategies for a full {@link SseQueue}. */
export type SseOverflowPolicy = "drop" | "error" | "newest";

/** Constructor options for {@link SseQueue}. */
export interface SseQueueOptions {
  /**
   * Maximum number of encoded SSE frames the queue will hold before applying
   * the overflow policy.  Must be >= 1.  Defaults to `64`.
   */
  capacity?: number;

  /**
   * Queue length at which {@link SseQueue.isBackpressured} returns `true`.
   * Expressed as a fraction of `capacity` (0 < highWaterMark <= 1).
   * Defaults to `0.75` (i.e. 75 % of `capacity`).
   */
  highWaterMark?: number;

  /**
   * What to do when a new item arrives and the queue is full.
   * - `"drop"`   — discard the incoming item (default).
   * - `"error"`  — signal a terminal error so callers can close the stream.
   * - `"newest"` — evict the oldest item to make room for the new one.
   */
  policy?: SseOverflowPolicy;
}

/** Snapshot of queue health, suitable for structured logging or metrics. */
export interface SseQueueMetrics {
  /** Current number of items waiting in the queue. */
  depth: number;
  /** Maximum queue depth seen during this connection. */
  peakDepth: number;
  /** Total events successfully enqueued. */
  enqueued: number;
  /** Total events dropped (policy="drop") or that triggered overflow. */
  dropped: number;
  /** Total events evicted to make room for newer ones (policy="newest"). */
  evicted: number;
  /** `true` when depth >= highWaterMark threshold. */
  backpressured: boolean;
  /** Queue capacity. */
  capacity: number;
}

// ---------------------------------------------------------------------------
// SseQueue
// ---------------------------------------------------------------------------

/**
 * Bounded FIFO queue for SSE frames with configurable overflow policy.
 *
 * The queue is not thread-safe in the multi-thread sense, but Node.js is
 * single-threaded and async operations between enqueue/drain calls cannot
 * interleave, so this is safe for the intended SSE use-case.
 */
export class SseQueue {
  private readonly _capacity: number;
  private readonly _hwm: number; // high-water-mark (absolute item count)
  private readonly _policy: SseOverflowPolicy;

  private readonly _items: Uint8Array[] = [];

  private _enqueued = 0;
  private _dropped = 0;
  private _evicted = 0;
  private _peakDepth = 0;

  /** `true` after a terminal overflow in "error" policy mode. */
  private _terminated = false;

  constructor(opts: SseQueueOptions = {}) {
    const capacity = opts.capacity ?? 64;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SseQueue: capacity must be a positive integer, got ${capacity}`);
    }

    const hwmFraction = opts.highWaterMark ?? 0.75;
    if (hwmFraction <= 0 || hwmFraction > 1) {
      throw new RangeError(
        `SseQueue: highWaterMark must be in (0, 1], got ${hwmFraction}`,
      );
    }

    this._capacity = capacity;
    this._hwm = Math.max(1, Math.ceil(capacity * hwmFraction));
    this._policy = opts.policy ?? "drop";
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Attempt to add an encoded SSE frame to the queue.
   *
   * @returns
   *   - `"ok"` — frame accepted.
   *   - `"backpressured"` — frame accepted, but queue has crossed the HWM.
   *   - `"dropped"` — frame rejected (policy=`"drop"` and queue is full).
   *   - `"evicted"` — oldest frame removed, new frame accepted (policy=`"newest"`).
   *   - `"error"` — queue in terminal error state (policy=`"error"` was triggered).
   */
  enqueue(chunk: Uint8Array): "ok" | "backpressured" | "dropped" | "evicted" | "error" {
    if (this._terminated) {
      this._dropped++;
      return "error";
    }

    if (this._items.length >= this._capacity) {
      // Queue is full — apply the overflow policy.
      switch (this._policy) {
        case "drop":
          this._dropped++;
          return "dropped";

        case "error":
          this._dropped++;
          this._terminated = true;
          return "error";

        case "newest":
          // Evict the oldest (front) item.
          this._items.shift();
          this._evicted++;
          break;
      }
    }

    this._items.push(chunk);
    this._enqueued++;

    if (this._items.length > this._peakDepth) {
      this._peakDepth = this._items.length;
    }

    return this._items.length >= this._hwm ? "backpressured" : "ok";
  }

  /**
   * Drain all pending frames from the queue and return them in FIFO order.
   * After draining, the queue is empty.
   */
  drain(): Uint8Array[] {
    return this._items.splice(0);
  }

  /**
   * Peek at the next item without removing it.
   * Returns `undefined` if the queue is empty.
   */
  peek(): Uint8Array | undefined {
    return this._items[0];
  }

  /**
   * `true` when the queue depth is at or above the high-water mark.
   * Producers should check this and slow down or skip non-critical events.
   */
  isBackpressured(): boolean {
    return this._items.length >= this._hwm;
  }

  /**
   * `true` when the `"error"` policy was triggered and the queue cannot
   * accept any more items.  Callers should close the SSE stream immediately.
   */
  isTerminated(): boolean {
    return this._terminated;
  }

  /** Current number of frames waiting in the queue. */
  get depth(): number {
    return this._items.length;
  }

  /** Snapshot of all queue health counters. */
  metrics(): SseQueueMetrics {
    return {
      depth: this._items.length,
      peakDepth: this._peakDepth,
      enqueued: this._enqueued,
      dropped: this._dropped,
      evicted: this._evicted,
      backpressured: this.isBackpressured(),
      capacity: this._capacity,
    };
  }

  /** Reset all counters and clear the queue (useful for testing). */
  reset(): void {
    this._items.length = 0;
    this._enqueued = 0;
    this._dropped = 0;
    this._evicted = 0;
    this._peakDepth = 0;
    this._terminated = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a structured log object from queue metrics for use in logger calls.
 *
 * ```ts
 * logger.warn("SSE backpressure detected", sseMetricsLog(q.metrics(), { streamId }));
 * ```
 */
export function sseMetricsLog(
  metrics: SseQueueMetrics,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sse_queue_depth: metrics.depth,
    sse_queue_peak: metrics.peakDepth,
    sse_queue_capacity: metrics.capacity,
    sse_enqueued: metrics.enqueued,
    sse_dropped: metrics.dropped,
    sse_evicted: metrics.evicted,
    sse_backpressured: metrics.backpressured,
    ...context,
  };
}

/**
 * Encode a named SSE event frame into a `Uint8Array`.
 *
 * Format per the HTML living standard:
 * ```
 * event: <name>\n
 * data: <json>\n
 * \n
 * ```
 */
export function encodeSSEFrame(
  encoder: TextEncoder,
  event: string,
  data: unknown,
): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Encode an SSE comment (keep-alive ping) frame.
 *
 * ```
 * : keep-alive\n
 * \n
 * ```
 */
export function encodeSSEComment(encoder: TextEncoder, comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

/**
 * Flush all pending frames from `queue` into `controller`.
 *
 * Returns `"ok"` if the flush completed normally or `"closed"` if the
 * controller threw (indicating the client disconnected mid-flush).
 */
export function flushQueue(
  queue: SseQueue,
  controller: ReadableStreamDefaultController,
): "ok" | "closed" {
  for (const chunk of queue.drain()) {
    try {
      controller.enqueue(chunk);
    } catch {
      // Controller already closed — client has disconnected.
      return "closed";
    }
  }
  return "ok";
}
