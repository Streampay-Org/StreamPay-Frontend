/**
 * Shared primitives for bounded Server-Sent Events (SSE) connections.
 *
 * Every long-lived SSE endpoint in StreamPay needs the same two guarantees:
 *
 * 1. **Bounded heartbeats** — a keep-alive comment is written on a fixed
 *    cadence, but never more than `maxHeartbeats` times, so an abandoned or
 *    misbehaving client cannot pin an open connection (and its timers /
 *    listeners) open forever.
 * 2. **Dead-client detection** — the connection is closed as soon as the
 *    client disconnects (request abort), the underlying stream rejects a
 *    write, or the connection exceeds its idle budget. Closing is exactly
 *    once, and all timers / listeners are released in the same pass.
 *
 * All limits are explicit options so route handlers can derive them from
 * environment variables and tests can inject tiny values for deterministic
 * runs. The helper never logs; callers pass an `onClose` hook for
 * diagnostics/metrics.
 */

/** Why an SSE connection ended. */
export type SseCloseReason =
  | "aborted"
  | "client-gone"
  | "max-heartbeats"
  | "max-idle"
  | "max-events"
  | "manual";

/** Observable counters for a closed connection. */
export interface SseStreamStats {
  /** Number of data events successfully enqueued. */
  eventsSent: number;
  /** Number of heartbeat comments successfully enqueued. */
  heartbeatsSent: number;
  /** The close reason, or `null` while the connection is still open. */
  closeReason: SseCloseReason | null;
}

export interface SseConnectionOptions {
  /** Abort signal from the incoming request; aborting closes the stream. */
  signal: AbortSignal;
  /**
   * Milliseconds between heartbeat comments. `0` disables heartbeats
   * entirely (e.g. endpoints whose data events already act as keep-alives).
   */
  heartbeatIntervalMs?: number;
  /**
   * Maximum number of heartbeats before the stream closes. `0` disables the
   * bound (not recommended — keep-alives should always be bounded).
   */
  maxHeartbeats?: number;
  /**
   * Close the stream after this many milliseconds without a successful write.
   * `0` disables the idle deadline.
   */
  maxIdleMs?: number;
  /**
   * Maximum number of data events before the stream closes. `0` means
   * unbounded data events (heartbeats are still bounded independently).
   */
  maxEvents?: number;
  /** Called after each successful heartbeat (for metrics / debug logs). */
  onHeartbeat?: (heartbeatsSent: number) => void;
  /** Called exactly once when the connection closes. */
  onClose?: (reason: SseCloseReason, stats: SseStreamStats) => void;
}

export interface SseConnection {
  /**
   * Enqueue a named SSE data frame. Returns `false` when the connection has
   * closed (bounded, client gone, aborted, …) so callers can stop producing.
   */
  send(event: string, data: unknown): boolean;
  /** Close the connection exactly once with the given reason. */
  close(reason?: SseCloseReason): void;
  /** Current counters / close state. */
  stats(): SseStreamStats;
}

/** Encode a named SSE data frame. */
export function encodeSseEvent(
  encoder: TextEncoder,
  event: string,
  data: unknown,
): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Encode an SSE heartbeat comment (no event is dispatched to the client). */
export function encodeSseHeartbeat(
  encoder: TextEncoder,
  sequence: number,
): Uint8Array {
  return encoder.encode(`: heartbeat ${sequence}\n\n`);
}

/** Read an env-tunable numeric SSE setting, falling back to `fallback`. */
export function sseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Milliseconds between keep-alive heartbeat comments (default 30 s). */
export function getSseHeartbeatIntervalMs(): number {
  return sseEnvNumber("SSE_HEARTBEAT_INTERVAL_MS", 30_000);
}

/**
 * Maximum number of heartbeats before the server closes the stream
 * (default 120 ≈ 1 hour at the default 30 s cadence).
 */
export function getSseMaxHeartbeats(): number {
  return sseEnvNumber("SSE_HEARTBEAT_MAX", 120);
}

/**
 * Maximum idle time (no successful write) before the server closes the
 * stream — a safety net for clients that vanish without a TCP teardown.
 */
export function getSseMaxIdleMs(): number {
  return sseEnvNumber("SSE_MAX_IDLE_MS", 120_000);
}

/**
 * Create a bounded, dead-client-aware SSE connection backed by a
 * `ReadableStreamDefaultController`.
 *
 * The returned handle owns the controller: `close()` (for any reason) is the
 * single path that terminates the stream, clears timers, detaches the abort
 * listener, and notifies `onClose` exactly once.
 */
export function createSseConnection(
  controller: ReadableStreamDefaultController<Uint8Array>,
  options: SseConnectionOptions,
): SseConnection {
  const {
    signal,
    heartbeatIntervalMs = 0,
    maxHeartbeats = 0,
    maxIdleMs = 0,
    maxEvents = 0,
    onHeartbeat,
    onClose,
  } = options;

  const encoder = new TextEncoder();

  let closed = false;
  let closeReason: SseCloseReason | null = null;
  let eventsSent = 0;
  let heartbeatsSent = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const currentStats = (): SseStreamStats => ({
    eventsSent,
    heartbeatsSent,
    closeReason,
  });

  const clearTimers = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const armIdleDeadline = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (maxIdleMs > 0) {
      idleTimer = setTimeout(() => {
        if (!closed) {
          close("max-idle");
        }
      }, maxIdleMs);
    }
  };

  const close = (reason: SseCloseReason = "manual"): void => {
    if (closed) {
      return;
    }
    closed = true;
    closeReason = reason;
    clearTimers();
    signal.removeEventListener("abort", onAbort);
    try {
      controller.close();
    } catch {
      // The runtime may already have closed the stream (client cancelled).
    }
    if (onClose) {
      onClose(reason, currentStats());
    }
  };

  const onAbort = (): void => {
    close("aborted");
  };

  const write = (chunk: Uint8Array): boolean => {
    if (closed) {
      return false;
    }
    try {
      controller.enqueue(chunk);
      armIdleDeadline();
      return true;
    } catch {
      // The runtime rejected the write: the client is gone.
      close("client-gone");
      return false;
    }
  };

  if (heartbeatIntervalMs > 0 && maxHeartbeats > 0) {
    heartbeatTimer = setInterval(() => {
      if (closed) {
        return;
      }
      if (heartbeatsSent >= maxHeartbeats) {
        close("max-heartbeats");
        return;
      }
      const next = heartbeatsSent + 1;
      if (write(encodeSseHeartbeat(encoder, next))) {
        heartbeatsSent = next;
        onHeartbeat?.(heartbeatsSent);
      }
    }, heartbeatIntervalMs);
  }

  signal.addEventListener("abort", onAbort, { once: true });
  armIdleDeadline();

  return {
    send(event: string, data: unknown): boolean {
      if (closed) {
        return false;
      }
      if (maxEvents > 0 && eventsSent >= maxEvents) {
        close("max-events");
        return false;
      }
      if (write(encodeSseEvent(encoder, event, data))) {
        eventsSent += 1;
        return true;
      }
      return false;
    },
    close,
    stats: currentStats,
  };
}
