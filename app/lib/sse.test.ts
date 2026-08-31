/**
 * @jest-environment node
 *
 * Unit tests for the shared bounded-heartbeat / dead-client-detection SSE
 * connection helper (issue #1372).
 */

import {
  createSseConnection,
  encodeSseEvent,
  encodeSseHeartbeat,
} from "./sse";

function makeController() {
  const enqueue = jest.fn();
  const close = jest.fn();
  const controller = {
    enqueue,
    close,
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { controller, enqueue, close };
}

describe("createSseConnection", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("enqueues data events, counts them, and closes exactly once", () => {
    const { controller, enqueue, close } = makeController();
    const abort = new AbortController();
    const sse = createSseConnection(controller, { signal: abort.signal });

    expect(sse.send("indexer_status", { ok: true })).toBe(true);
    expect(sse.send("indexer_status", { ok: false })).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(sse.stats().eventsSent).toBe(2);
    expect(close).not.toHaveBeenCalled();

    sse.close("manual");
    expect(close).toHaveBeenCalledTimes(1);
    expect(sse.stats().closeReason).toBe("manual");

    // Close is idempotent.
    sse.close("manual");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes with max-events when the data-event bound is reached", () => {
    const { controller, close } = makeController();
    const abort = new AbortController();
    const onClose = jest.fn();
    const sse = createSseConnection(controller, {
      signal: abort.signal,
      maxEvents: 2,
      onClose,
    });

    expect(sse.send("e", 1)).toBe(true);
    expect(sse.send("e", 2)).toBe(true);
    expect(sse.send("e", 3)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(
      "max-events",
      expect.objectContaining({ eventsSent: 2 }),
    );

    expect(sse.send("e", 4)).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1); // exactly once
  });

  it("sends bounded heartbeats then closes", () => {
    jest.useFakeTimers();
    const { controller, close } = makeController();
    const abort = new AbortController();
    const onHeartbeat = jest.fn();
    const onClose = jest.fn();
    createSseConnection(controller, {
      signal: abort.signal,
      heartbeatIntervalMs: 10,
      maxHeartbeats: 3,
      onHeartbeat,
      onClose,
    });

    jest.advanceTimersByTime(10); // heartbeat 1
    jest.advanceTimersByTime(10); // heartbeat 2
    jest.advanceTimersByTime(10); // heartbeat 3
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();

    // The next tick sees the bound reached and closes the connection.
    jest.advanceTimersByTime(10);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(
      "max-heartbeats",
      expect.objectContaining({ heartbeatsSent: 3 }),
    );
  });

  it("detects a dead client when the controller rejects a write", () => {
    const enqueue = jest.fn(() => {
      throw new Error("stream closed");
    });
    const close = jest.fn();
    const abort = new AbortController();
    const onClose = jest.fn();
    const sse = createSseConnection(
      { enqueue, close } as unknown as ReadableStreamDefaultController<Uint8Array>,
      { signal: abort.signal, onClose },
    );

    expect(sse.send("e", 1)).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(
      "client-gone",
      expect.objectContaining({ eventsSent: 0 }),
    );
  });

  it("closes when the request aborts (client disconnect)", () => {
    const { controller, close } = makeController();
    const abort = new AbortController();
    const onClose = jest.fn();
    createSseConnection(controller, { signal: abort.signal, onClose });

    abort.abort();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("aborted", expect.any(Object));
  });

  it("closes after the idle deadline without successful writes", () => {
    jest.useFakeTimers();
    const { controller, close } = makeController();
    const abort = new AbortController();
    const onClose = jest.fn();
    const sse = createSseConnection(controller, {
      signal: abort.signal,
      maxIdleMs: 100,
      onClose,
    });

    sse.send("e", 1); // resets the idle deadline
    jest.advanceTimersByTime(99);
    expect(close).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("max-idle", expect.any(Object));
  });

  it("returns false for sends after close", () => {
    const { controller } = makeController();
    const abort = new AbortController();
    const sse = createSseConnection(controller, { signal: abort.signal });

    sse.close("manual");
    expect(sse.send("e", 1)).toBe(false);
  });
});

describe("SSE frame encoders", () => {
  it("encodes named data events", () => {
    const encoder = new TextEncoder();
    const bytes = encodeSseEvent(encoder, "evt", { a: 1 });
    expect(new TextDecoder().decode(bytes)).toBe('event: evt\ndata: {"a":1}\n\n');
  });

  it("encodes heartbeat comments", () => {
    const encoder = new TextEncoder();
    const bytes = encodeSseHeartbeat(encoder, 3);
    expect(new TextDecoder().decode(bytes)).toBe(": heartbeat 3\n\n");
  });
});
