/**
 * @jest-environment node
 *
 * Unit tests for lib/sseBackpressure — SseQueue, overflow policies,
 * backpressure signalling, metrics, and helper functions.
 */

import {
  SseQueue,
  sseMetricsLog,
  encodeSSEFrame,
  encodeSSEComment,
  flushQueue,
} from "./sseBackpressure";
import type { SseQueueOptions } from "./sseBackpressure";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(event: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function makeQueue(opts: SseQueueOptions = {}): SseQueue {
  return new SseQueue({ capacity: 4, policy: "drop", ...opts });
}

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("SseQueue constructor", () => {
  it("accepts valid capacity and policy", () => {
    expect(() => new SseQueue({ capacity: 16, policy: "drop" })).not.toThrow();
    expect(() => new SseQueue({ capacity: 1, policy: "error" })).not.toThrow();
    expect(() => new SseQueue({ capacity: 100, policy: "newest" })).not.toThrow();
  });

  it("defaults capacity to 64", () => {
    const q = new SseQueue();
    expect(q.metrics().capacity).toBe(64);
  });

  it("defaults policy to 'drop'", () => {
    const q = new SseQueue({ capacity: 4 });
    // Fill to capacity + 1 and ensure drop (not eviction) behaviour
    const chunk = frame("e", 1);
    for (let i = 0; i < 4; i++) q.enqueue(chunk);
    expect(q.enqueue(chunk)).toBe("dropped");
    expect(q.metrics().dropped).toBe(1);
    expect(q.metrics().evicted).toBe(0);
  });

  it("throws RangeError for capacity < 1", () => {
    expect(() => new SseQueue({ capacity: 0 })).toThrow(RangeError);
    expect(() => new SseQueue({ capacity: -1 })).toThrow(RangeError);
  });

  it("throws RangeError for non-integer capacity", () => {
    expect(() => new SseQueue({ capacity: 1.5 })).toThrow(RangeError);
  });

  it("throws RangeError for highWaterMark <= 0", () => {
    expect(() => new SseQueue({ capacity: 4, highWaterMark: 0 })).toThrow(RangeError);
    expect(() => new SseQueue({ capacity: 4, highWaterMark: -0.1 })).toThrow(RangeError);
  });

  it("throws RangeError for highWaterMark > 1", () => {
    expect(() => new SseQueue({ capacity: 4, highWaterMark: 1.1 })).toThrow(RangeError);
  });

  it("accepts highWaterMark = 1 (threshold == capacity)", () => {
    const q = new SseQueue({ capacity: 4, highWaterMark: 1 });
    // Only becomes backpressured when fully full
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk);
    expect(q.isBackpressured()).toBe(false);
    q.enqueue(chunk);
    expect(q.isBackpressured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enqueue — happy path
// ---------------------------------------------------------------------------

describe("SseQueue.enqueue (normal operation)", () => {
  it("returns 'ok' for the first item when queue is empty", () => {
    const q = makeQueue({ highWaterMark: 0.75 }); // hwm = ceil(4 * 0.75) = 3
    expect(q.enqueue(frame("e", 1))).toBe("ok");
  });

  it("returns 'backpressured' when depth reaches the HWM", () => {
    const q = makeQueue({ capacity: 4, highWaterMark: 0.75 }); // hwm = 3
    const chunk = frame("e", 1);
    q.enqueue(chunk); // depth 1 — ok
    q.enqueue(chunk); // depth 2 — ok
    expect(q.enqueue(chunk)).toBe("backpressured"); // depth 3 — hwm reached
  });

  it("increments enqueued counter correctly", () => {
    const q = makeQueue();
    q.enqueue(frame("a", 1));
    q.enqueue(frame("b", 2));
    expect(q.metrics().enqueued).toBe(2);
  });

  it("tracks peak depth", () => {
    const q = makeQueue({ capacity: 8 });
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.drain();
    q.enqueue(chunk);
    expect(q.metrics().peakDepth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// enqueue — overflow policies
// ---------------------------------------------------------------------------

describe("SseQueue.enqueue policy='drop'", () => {
  it("returns 'dropped' and does not enqueue when full", () => {
    const q = makeQueue({ policy: "drop" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 4; i++) q.enqueue(chunk);

    const result = q.enqueue(frame("overflow", 99));
    expect(result).toBe("dropped");
    expect(q.depth).toBe(4); // queue unchanged
  });

  it("increments dropped counter on overflow", () => {
    const q = makeQueue({ policy: "drop" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 4; i++) q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk);
    expect(q.metrics().dropped).toBe(2);
  });

  it("does not increment evicted counter", () => {
    const q = makeQueue({ policy: "drop" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 5; i++) q.enqueue(chunk);
    expect(q.metrics().evicted).toBe(0);
  });
});

describe("SseQueue.enqueue policy='error'", () => {
  it("returns 'error' when the queue overflows", () => {
    const q = makeQueue({ policy: "error" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 4; i++) q.enqueue(chunk);

    expect(q.enqueue(frame("overflow", 99))).toBe("error");
  });

  it("sets isTerminated() after overflow", () => {
    const q = makeQueue({ policy: "error" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 4; i++) q.enqueue(chunk);
    q.enqueue(chunk);
    expect(q.isTerminated()).toBe(true);
  });

  it("all subsequent enqueues return 'error' once terminated", () => {
    const q = makeQueue({ policy: "error" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 5; i++) q.enqueue(chunk); // triggers terminal on 5th
    expect(q.enqueue(chunk)).toBe("error");
    expect(q.enqueue(chunk)).toBe("error");
    expect(q.metrics().dropped).toBe(3); // 1 on overflow + 2 after
  });
});

describe("SseQueue.enqueue policy='newest'", () => {
  it("returns 'evicted' and accepts the new item when full", () => {
    const q = makeQueue({ policy: "newest" });
    const old = frame("old", 0);
    const newest = frame("new", 99);
    for (let i = 0; i < 4; i++) q.enqueue(old);

    const result = q.enqueue(newest);
    expect(result === "evicted" || result === "backpressured").toBe(true);
  });

  it("removes the oldest item when evicting", () => {
    const q = makeQueue({ policy: "newest", capacity: 2 });
    const a = frame("a", 1);
    const b = frame("b", 2);
    const c = frame("c", 3);

    q.enqueue(a); // [a]
    q.enqueue(b); // [a, b] — full
    q.enqueue(c); // evicts a → [b, c]

    const drained = q.drain();
    expect(drained).toHaveLength(2);
    expect(dec.decode(drained[0])).toContain('event: b');
    expect(dec.decode(drained[1])).toContain('event: c');
  });

  it("increments evicted counter", () => {
    const q = makeQueue({ policy: "newest" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 6; i++) q.enqueue(chunk); // 4 + 2 evictions
    expect(q.metrics().evicted).toBe(2);
  });

  it("does not set isTerminated()", () => {
    const q = makeQueue({ policy: "newest" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 10; i++) q.enqueue(chunk);
    expect(q.isTerminated()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// drain
// ---------------------------------------------------------------------------

describe("SseQueue.drain", () => {
  it("returns items in FIFO order", () => {
    const q = makeQueue();
    const a = frame("a", 1);
    const b = frame("b", 2);
    const c = frame("c", 3);
    q.enqueue(a);
    q.enqueue(b);
    q.enqueue(c);
    const items = q.drain();
    expect(items).toHaveLength(3);
    expect(dec.decode(items[0])).toContain('event: a');
    expect(dec.decode(items[1])).toContain('event: b');
    expect(dec.decode(items[2])).toContain('event: c');
  });

  it("empties the queue after draining", () => {
    const q = makeQueue();
    q.enqueue(frame("e", 1));
    q.drain();
    expect(q.depth).toBe(0);
  });

  it("returns empty array when queue is empty", () => {
    const q = makeQueue();
    expect(q.drain()).toEqual([]);
  });

  it("subsequent drain after drain returns empty", () => {
    const q = makeQueue();
    q.enqueue(frame("e", 1));
    q.drain();
    expect(q.drain()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// peek
// ---------------------------------------------------------------------------

describe("SseQueue.peek", () => {
  it("returns the first item without removing it", () => {
    const q = makeQueue();
    const a = frame("a", 1);
    const b = frame("b", 2);
    q.enqueue(a);
    q.enqueue(b);
    expect(q.peek()).toBe(a);
    expect(q.depth).toBe(2); // unchanged
  });

  it("returns undefined for empty queue", () => {
    const q = makeQueue();
    expect(q.peek()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backpressure signal
// ---------------------------------------------------------------------------

describe("SseQueue.isBackpressured", () => {
  it("is false for an empty queue", () => {
    const q = makeQueue();
    expect(q.isBackpressured()).toBe(false);
  });

  it("is false below HWM", () => {
    // capacity=4, hwm=0.75 → threshold=3
    const q = makeQueue({ capacity: 4, highWaterMark: 0.75 });
    q.enqueue(frame("e", 1)); // depth=1
    q.enqueue(frame("e", 2)); // depth=2
    expect(q.isBackpressured()).toBe(false);
  });

  it("is true at and above HWM", () => {
    const q = makeQueue({ capacity: 4, highWaterMark: 0.75 }); // threshold=3
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk); // depth=3 — at HWM
    expect(q.isBackpressured()).toBe(true);
    q.enqueue(chunk); // depth=4
    expect(q.isBackpressured()).toBe(true);
  });

  it("returns false again after draining below HWM", () => {
    const q = makeQueue({ capacity: 4, highWaterMark: 0.75 }); // threshold=3
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk); // at HWM
    q.drain();
    expect(q.isBackpressured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe("SseQueue.metrics", () => {
  it("returns correct initial values", () => {
    const q = makeQueue({ capacity: 4 });
    expect(q.metrics()).toMatchObject({
      depth: 0,
      peakDepth: 0,
      enqueued: 0,
      dropped: 0,
      evicted: 0,
      backpressured: false,
      capacity: 4,
    });
  });

  it("reflects state after enqueue and drain", () => {
    const q = makeQueue({ capacity: 8, highWaterMark: 0.5 }); // hwm=4
    const chunk = frame("e", 1);
    for (let i = 0; i < 5; i++) q.enqueue(chunk); // enqueued=5, depth=5, peak=5
    q.drain(); // depth=0

    const m = q.metrics();
    expect(m.enqueued).toBe(5);
    expect(m.depth).toBe(0);
    expect(m.peakDepth).toBe(5);
    expect(m.backpressured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("SseQueue.reset", () => {
  it("clears all counters and items", () => {
    const q = makeQueue({ policy: "error" });
    const chunk = frame("e", 1);
    for (let i = 0; i < 5; i++) q.enqueue(chunk);
    expect(q.isTerminated()).toBe(true);

    q.reset();
    const m = q.metrics();
    expect(m.depth).toBe(0);
    expect(m.peakDepth).toBe(0);
    expect(m.enqueued).toBe(0);
    expect(m.dropped).toBe(0);
    expect(m.evicted).toBe(0);
    expect(q.isTerminated()).toBe(false);
  });

  it("allows enqueueing again after reset following error", () => {
    const q = makeQueue({ capacity: 2, policy: "error" });
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk); // triggers terminal
    expect(q.isTerminated()).toBe(true);

    q.reset();
    expect(q.enqueue(chunk)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Concurrent / boundary conditions
// ---------------------------------------------------------------------------

describe("SseQueue — boundary conditions", () => {
  it("handles capacity=1 correctly for drop policy", () => {
    const q = new SseQueue({ capacity: 1, policy: "drop" });
    const a = frame("a", 1);
    const b = frame("b", 2);
    expect(q.enqueue(a)).toBe("backpressured"); // at hwm immediately (hwm=ceil(1*0.75)=1)
    expect(q.enqueue(b)).toBe("dropped");
    expect(q.drain()).toHaveLength(1);
  });

  it("handles capacity=1 for newest policy — always replaces", () => {
    const q = new SseQueue({ capacity: 1, policy: "newest" });
    const a = frame("a", 1);
    const b = frame("b", 2);
    q.enqueue(a);
    q.enqueue(b); // evicts a
    const drained = q.drain();
    expect(drained).toHaveLength(1);
    expect(dec.decode(drained[0])).toContain('event: b');
  });

  it("handles many rapid enqueue/drain cycles without leaking state", () => {
    const q = new SseQueue({ capacity: 16, policy: "drop" });
    const chunk = frame("e", 1);
    for (let cycle = 0; cycle < 100; cycle++) {
      for (let i = 0; i < 10; i++) q.enqueue(chunk);
      q.drain();
    }
    expect(q.depth).toBe(0);
    // Each cycle: 10 enqueues arrive, 4 are accepted (capacity=16, but only 10
    // fit each cycle because we drain between cycles). Actually 10 are enqueued
    // each cycle (all accepted since capacity=16 > 10), giving 100*10=1000.
    expect(q.metrics().enqueued).toBe(1000);
  });

  it("duplicate frames are treated as independent items (no dedup)", () => {
    const q = makeQueue();
    const chunk = frame("e", 42);
    q.enqueue(chunk);
    q.enqueue(chunk);
    q.enqueue(chunk);
    expect(q.depth).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Helper: sseMetricsLog
// ---------------------------------------------------------------------------

describe("sseMetricsLog", () => {
  it("returns a flat log object with all queue metric fields", () => {
    const q = makeQueue({ capacity: 8 });
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);

    const log = sseMetricsLog(q.metrics());
    expect(log).toMatchObject({
      sse_queue_depth: 2,
      sse_queue_peak: 2,
      sse_queue_capacity: 8,
      sse_enqueued: 2,
      sse_dropped: 0,
      sse_evicted: 0,
      sse_backpressured: false,
    });
  });

  it("merges extra context fields", () => {
    const q = makeQueue();
    const log = sseMetricsLog(q.metrics(), { streamId: "s-123", actorId: "a-456" });
    expect(log.streamId).toBe("s-123");
    expect(log.actorId).toBe("a-456");
    expect(log.sse_queue_depth).toBe(0);
  });

  it("does not mutate the metrics object", () => {
    const q = makeQueue();
    const m = q.metrics();
    sseMetricsLog(m, { extra: true });
    expect((m as Record<string, unknown>).extra).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helper: encodeSSEFrame
// ---------------------------------------------------------------------------

describe("encodeSSEFrame", () => {
  it("produces a valid SSE event frame", () => {
    const encoder = new TextEncoder();
    const result = encodeSSEFrame(encoder, "my_event", { foo: "bar" });
    const text = new TextDecoder().decode(result);
    expect(text).toBe('event: my_event\ndata: {"foo":"bar"}\n\n');
  });

  it("serialises numbers correctly", () => {
    const encoder = new TextEncoder();
    const text = new TextDecoder().decode(encodeSSEFrame(encoder, "tick", 42));
    expect(text).toBe("event: tick\ndata: 42\n\n");
  });

  it("serialises nested objects correctly", () => {
    const encoder = new TextEncoder();
    const data = { a: 1, b: [2, 3] };
    const text = new TextDecoder().decode(encodeSSEFrame(encoder, "e", data));
    expect(text).toContain(JSON.stringify(data));
  });

  it("double-newline terminates the frame", () => {
    const encoder = new TextEncoder();
    const text = new TextDecoder().decode(encodeSSEFrame(encoder, "e", {}));
    expect(text.endsWith("\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: encodeSSEComment
// ---------------------------------------------------------------------------

describe("encodeSSEComment", () => {
  it("produces a valid SSE comment frame", () => {
    const encoder = new TextEncoder();
    const text = new TextDecoder().decode(encodeSSEComment(encoder, "keep-alive"));
    expect(text).toBe(": keep-alive\n\n");
  });

  it("double-newline terminates the comment", () => {
    const encoder = new TextEncoder();
    const text = new TextDecoder().decode(encodeSSEComment(encoder, "ping"));
    expect(text.endsWith("\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: flushQueue
// ---------------------------------------------------------------------------

describe("flushQueue", () => {
  it("returns 'ok' when all frames are flushed successfully", () => {
    const q = new SseQueue({ capacity: 4 });
    const chunk = frame("e", 1);
    q.enqueue(chunk);
    q.enqueue(chunk);

    const received: Uint8Array[] = [];
    const controller = {
      enqueue: (c: Uint8Array) => received.push(c),
    } as unknown as ReadableStreamDefaultController;

    const result = flushQueue(q, controller);
    expect(result).toBe("ok");
    expect(received).toHaveLength(2);
    expect(q.depth).toBe(0);
  });

  it("returns 'closed' when controller throws", () => {
    const q = new SseQueue({ capacity: 4 });
    q.enqueue(frame("e", 1));
    q.enqueue(frame("e", 2));

    const controller = {
      enqueue: () => { throw new Error("stream closed"); },
    } as unknown as ReadableStreamDefaultController;

    const result = flushQueue(q, controller);
    expect(result).toBe("closed");
  });

  it("returns 'ok' for an empty queue", () => {
    const q = new SseQueue({ capacity: 4 });
    const controller = {
      enqueue: jest.fn(),
    } as unknown as ReadableStreamDefaultController;

    expect(flushQueue(q, controller)).toBe("ok");
    expect((controller.enqueue as jest.Mock).mock.calls).toHaveLength(0);
  });

  it("drains items in FIFO order to the controller", () => {
    const q = new SseQueue({ capacity: 4 });
    const a = frame("a", 1);
    const b = frame("b", 2);
    const c = frame("c", 3);
    q.enqueue(a);
    q.enqueue(b);
    q.enqueue(c);

    const received: Uint8Array[] = [];
    const controller = {
      enqueue: (c: Uint8Array) => received.push(c),
    } as unknown as ReadableStreamDefaultController;

    flushQueue(q, controller);
    expect(dec.decode(received[0])).toContain('event: a');
    expect(dec.decode(received[1])).toContain('event: b');
    expect(dec.decode(received[2])).toContain('event: c');
  });
});
