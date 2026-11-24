/**
 * Concurrency tests for stream lifecycle route handlers.
 *
 * These tests exercise the per-stream lock (withLock) to verify that
 * concurrent requests cannot interleave and corrupt stream state.
 *
 * State-machine rules encoded (see app/lib/state-machine.ts):
 * - active + pause  -> paused (mutating transition; appends 1 history event)
 * - paused + pause  -> paused (idempotent 200 no-op; appends 0 history events)
 * - paused + start  -> active (resume; appends 1 history event)
 * - active + start  -> 409 INVALID_STREAM_STATE in start/route.ts
 * - active/paused + stop   -> ended
 * - active/paused + settle -> ended
 * - ended + pause   -> 409 ILLEGAL_TRANSITION
 */

import { NextRequest } from "next/server";
import { db, resetDb, withLock } from "@/app/lib/db";
import {
  getRateLimitStore,
  InMemoryRateLimitStore,
  resetRateLimitStore,
} from "@/app/lib/rate-limit-store";
import * as rateLimitMiddleware from "@/src/middleware/rateLimit";
import { POST as pauseHandler } from "@/app/api/streams/[id]/pause/route";
import { POST as startHandler } from "@/app/api/streams/[id]/start/route";
import { POST as stopHandler } from "@/app/api/streams/[id]/stop/route";
import { POST as settleHandler } from "@/app/api/streams/[id]/settle/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(idempotencyKey?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return new NextRequest("http://localhost/api/streams/s1/pause", {
    method: "POST",
    headers,
  });
}

function makeParams(id = "s1"): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function activeStream(overrides = {}): any {
  return {
    id: "s1",
    recipient: "r1",
    rate: "10 XLM/day",
    schedule: "daily",
    status: "active" as const,
    recipientId: "r1",
    balance: 100,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    token: "XLM",
    ...overrides,
  };
}

function historyFor(streamId = "s1") {
  return db.streamHistory.query({ streamId, limit: 100 }).data;
}

let rateLimitSpy: jest.SpyInstance;

beforeEach(() => {
  resetDb({ s1: activeStream() });
  resetRateLimitStore();
  // Neutralize write-bucket throttling (10 req/min) so this suite tests
  // lock/state-machine concurrency rather than rate-limit enforcement.
  rateLimitSpy = jest
    .spyOn(rateLimitMiddleware, "streamsRateLimit")
    .mockResolvedValue({ allowed: true, headers: {} });
});

afterEach(() => {
  rateLimitSpy.mockRestore();
  const store = getRateLimitStore();
  if (store instanceof InMemoryRateLimitStore) {
    store.destroy();
  }
});

// ---------------------------------------------------------------------------
// 1. Same Idempotency-Key — only one state change
// ---------------------------------------------------------------------------

test("two concurrent pauses with the same Idempotency-Key produce one state change", async () => {
  const key = "idem-key-1";
  const [r1, r2] = await Promise.all([
    pauseHandler(makeReq(key), makeParams()),
    pauseHandler(makeReq(key), makeParams()),
  ]);

  // Both must succeed (200); second caller gets the cached replay.
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);

  // The stream must be paused with a single committed transition.
  expect(db.streams["s1"].status).toBe("paused");
  expect(historyFor("s1")).toHaveLength(1);
  expect(historyFor("s1")[0].type).toBe("paused");

  // Both responses must be identical (cached replay).
  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  expect(b1).toEqual(b2);
});

// ---------------------------------------------------------------------------
// 2. Different keys — both 200 (idempotent state machine), single transition
// ---------------------------------------------------------------------------

test("two concurrent pauses with different Idempotency-Keys: both 200 with a single transition", async () => {
  // State-machine rule: active.pause -> paused (mutates & records history);
  // paused.pause -> paused (idempotent 200 no-op, no second history event).
  const [r1, r2] = await Promise.all([
    pauseHandler(makeReq("key-a"), makeParams()),
    pauseHandler(makeReq("key-b"), makeParams()),
  ]);

  expect([r1.status, r2.status]).toEqual([200, 200]);
  expect(db.streams["s1"].status).toBe("paused");
  expect(historyFor("s1")).toHaveLength(1);
  expect(historyFor("s1")[0]).toMatchObject({
    type: "paused",
    fromStatus: "active",
    toStatus: "paused",
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrent pause + start
// ---------------------------------------------------------------------------

test("concurrent pause and start: serialized by lock with no lost update", async () => {
  // State-machine / route rules:
  // - If pause acquires the lock first: active -> paused (200), then start
  //   resumes paused -> active (200). Final status: "active", 2 history events.
  // - If start acquires the lock first: start rejects active with 409
  //   (start/route.ts requires draft or paused), then pause transitions
  //   active -> paused (200). Final status: "paused", 1 history event.
  const [pauseRes, startRes] = await Promise.all([
    pauseHandler(makeReq(), makeParams()),
    startHandler(
      new NextRequest("http://localhost/api/streams/s1/start", { method: "POST" }),
      makeParams(),
    ),
  ]);

  expect(pauseRes.status).toBe(200);
  expect([200, 409]).toContain(startRes.status);

  const history = historyFor("s1");
  if (startRes.status === 200) {
    expect(db.streams["s1"].status).toBe("active");
    expect(history).toHaveLength(2);
    expect(history.map((e: any) => e.type).sort()).toEqual(["paused", "resumed"]);
  } else {
    expect(db.streams["s1"].status).toBe("paused");
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("paused");
  }
});

test("start immediately after pause resumes stream to active (200)", async () => {
  // Explicit verification of paused.start -> active inside the lock.
  const pauseRes = await pauseHandler(makeReq(), makeParams());
  expect(pauseRes.status).toBe(200);
  expect(db.streams["s1"].status).toBe("paused");

  const startRes = await startHandler(
    new NextRequest("http://localhost/api/streams/s1/start", { method: "POST" }),
    makeParams(),
  );
  expect(startRes.status).toBe(200);
  expect(db.streams["s1"].status).toBe("active");
  expect(historyFor("s1")).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// 4. Concurrent pause + stop
// ---------------------------------------------------------------------------

test("concurrent pause and stop: the stop leaves the stream ended", async () => {
  // State-machine rule: active/paused.stop -> ended; ended.pause -> 409.
  const [pauseRes, stopRes] = await Promise.all([
    pauseHandler(makeReq(), makeParams()),
    stopHandler(
      new NextRequest("http://localhost/api/streams/s1/stop", { method: "POST" }),
      makeParams(),
    ),
  ]);

  expect(stopRes.status).toBe(200);
  expect([200, 409]).toContain(pauseRes.status);
  expect(db.streams["s1"].status).toBe("ended");
});

// ---------------------------------------------------------------------------
// 5. Concurrent pause + settle
// ---------------------------------------------------------------------------

test("concurrent pause and settle: serialized by lock and stream ends", async () => {
  // State-machine rule: active/paused.settle -> ended; ended.pause -> 409.
  const [pauseRes, settleRes] = await Promise.all([
    pauseHandler(makeReq(), makeParams()),
    settleHandler(
      new NextRequest("http://localhost/api/streams/s1/settle", {
        method: "POST",
        headers: { "Idempotency-Key": "idem-settle-1" },
      }),
      makeParams(),
    ),
  ]);

  expect(settleRes.status).toBe(200);
  expect([200, 409]).toContain(pauseRes.status);
  expect(db.streams["s1"].status).toBe("ended");
});

// ---------------------------------------------------------------------------
// 6. Idempotency — no double-write
// ---------------------------------------------------------------------------

test("repeated pause with same Idempotency-Key does not mutate state twice", async () => {
  const key = "idem-key-2";

  const r1 = await pauseHandler(makeReq(key), makeParams());
  expect(r1.status).toBe(200);
  const firstUpdatedAt = db.streams["s1"].updatedAt;

  // Second call — must return cached response, not re-write updatedAt
  const r2 = await pauseHandler(makeReq(key), makeParams());
  expect(r2.status).toBe(200);
  expect(db.streams["s1"].updatedAt).toBe(firstUpdatedAt);
  expect(historyFor("s1")).toHaveLength(1);

  const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
  expect(b1).toEqual(b2);
});

// ---------------------------------------------------------------------------
// 7. Active stream pause transition
// ---------------------------------------------------------------------------

test("pause on active stream transitions status to paused", async () => {
  resetDb({ s1: activeStream() });

  const res = await pauseHandler(makeReq(), makeParams());
  expect(res.status).toBe(200);

  const body = await res.json();
  expect(body.data.status).toBe("paused");
  expect(db.streams["s1"].status).toBe("paused");
});

// ---------------------------------------------------------------------------
// 8. Stream not found
// ---------------------------------------------------------------------------

test("pause on non-existent stream returns 404", async () => {
  const res = await pauseHandler(
    makeReq(),
    { params: Promise.resolve({ id: "does-not-exist" }) },
  );
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error.message).toMatch(/not found/i);
});

// ---------------------------------------------------------------------------
// 9. Already paused
// ---------------------------------------------------------------------------

test("pause on already-paused stream is an idempotent success", async () => {
  // State-machine rule: paused.pause -> paused (200 no-op, returns current stream).
  resetDb({ s1: { ...activeStream(), status: "paused" } });

  const res = await pauseHandler(makeReq(), makeParams());
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe("paused");
  expect(historyFor("s1")).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 10. Ended stream
// ---------------------------------------------------------------------------

test("pause on ended stream returns 409", async () => {
  // State-machine rule: ended.pause -> ILLEGAL_TRANSITION (409).
  resetDb({ s1: { ...activeStream(), status: "ended" } });

  const res = await pauseHandler(makeReq(), makeParams());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error.message).toMatch(/ended/i);
});

// ---------------------------------------------------------------------------
// 11. High-concurrency stress: N parallel pauses, single underlying transition
// ---------------------------------------------------------------------------

test("N concurrent pauses without idempotency key: all 200, exactly one transition", async () => {
  // State-machine rule: first caller transitions active -> paused (200) and
  // appends 1 history event; remaining N-1 callers observe paused.pause -> paused
  // (idempotent 200 no-op, 0 additional history events).
  const N = 20;
  const results = await Promise.all(
    Array.from({ length: N }, () => pauseHandler(makeReq(), makeParams())),
  );

  expect(results.every((r) => r.status === 200)).toBe(true);
  expect(db.streams["s1"].status).toBe("paused");
  expect(historyFor("s1")).toHaveLength(1);
  expect(historyFor("s1")[0]).toMatchObject({
    type: "paused",
    fromStatus: "active",
    toStatus: "paused",
  });
});

// ---------------------------------------------------------------------------
// 12. Explicit withLock ordering (same id serial, different ids parallel)
// ---------------------------------------------------------------------------

test("withLock serializes tasks on the same id and runs different ids in parallel", async () => {
  // Deterministic barrier using deferred promises (no wall-clock timers).
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const serialTrace: string[] = [];
  const t1 = withLock("same-id", async () => {
    serialTrace.push("t1:start");
    await firstGate;
    serialTrace.push("t1:end");
  });
  const t2 = withLock("same-id", async () => {
    serialTrace.push("t2:start");
    serialTrace.push("t2:end");
  });

  // Yield a microtask so t1 enters the lock and t2 queues behind it.
  await Promise.resolve();
  expect(serialTrace).toEqual(["t1:start"]);

  releaseFirst();
  await Promise.all([t1, t2]);
  expect(serialTrace).toEqual(["t1:start", "t1:end", "t2:start", "t2:end"]);

  // Different ids must enter their critical sections concurrently.
  let enteredA!: () => void;
  let enteredB!: () => void;
  const aEntered = new Promise<void>((resolve) => {
    enteredA = resolve;
  });
  const bEntered = new Promise<void>((resolve) => {
    enteredB = resolve;
  });

  let bothInside = false;
  let activeCount = 0;

  const pA = withLock("id-a", async () => {
    activeCount += 1;
    enteredA();
    await bEntered;
    if (activeCount === 2) bothInside = true;
    activeCount -= 1;
  });
  const pB = withLock("id-b", async () => {
    activeCount += 1;
    enteredB();
    await aEntered;
    if (activeCount === 2) bothInside = true;
    activeCount -= 1;
  });

  await Promise.all([pA, pB]);
  expect(bothInside).toBe(true);
});
