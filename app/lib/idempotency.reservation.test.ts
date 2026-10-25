/**
 * @jest-environment node
 *
 * Tests for idempotency reservation, commit, release, stale takeover, and fail-closed semantics.
 */

import { NextResponse } from "next/server";
import { db, resetDb, IDEMPOTENCY_INFLIGHT_TTL_MS } from "@/app/lib/db";
import {
  createNamespacedStore,
  withIdempotency,
  IdempotencyStore,
} from "@/app/lib/idempotency";

const STREAM_ID = "stream-res-1";

function postRequest(key: string, body: unknown = {}): Request {
  return new Request(`http://localhost/api/streams/${STREAM_ID}/settle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetDb();
});

describe("idempotency reservation, commit and release protocol", () => {
  // Scenario 1: Two concurrent settles, same key, same stream
  // Settlement client called once; one 200, the other 409 IDEMPOTENCY_IN_FLIGHT or the cached 200; stored record is the 200
  it("Scenario 1: Two concurrent settles with same key execute handler once and return 200 / 409 IDEMPOTENCY_IN_FLIGHT", async () => {
    const store = createNamespacedStore("res-test-1");
    let executionCount = 0;

    const handler = jest.fn(async () => {
      executionCount++;
      // Simulate delay in settlement
      await new Promise((resolve) => setTimeout(resolve, 50));
      return NextResponse.json({ status: "settled", count: executionCount }, { status: 200 });
    });

    const [res1, res2] = await Promise.all([
      withIdempotency(postRequest("key-concurrent"), "settle", store, handler, { resourceId: STREAM_ID }),
      withIdempotency(postRequest("key-concurrent"), "settle", store, handler, { resourceId: STREAM_ID }),
    ]);

    expect(executionCount).toBe(1);

    const statuses = [res1.status, res2.status].sort();
    if (statuses[0] === 200 && statuses[1] === 200) {
      // One got direct 200, one got replay 200
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    } else {
      expect(statuses).toEqual([200, 409]);
      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.headers.get("Retry-After")).toBe("1");
      const errBody = await conflictRes.json();
      expect(errBody.error?.code || errBody.code).toBe("IDEMPOTENCY_IN_FLIGHT");
    }

    // Verify stored record is 200
    const replayRes = await withIdempotency(postRequest("key-concurrent"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(replayRes.status).toBe(200);
    expect(replayRes.headers.get("Idempotency-Replay")).toBe("true");
    const body = await replayRes.json();
    expect(body.status).toBe("settled");
    expect(executionCount).toBe(1);
  });

  // Scenario 2: Handler returns 502
  // Nothing persisted; retry with the same key re-executes
  it("Scenario 2: Handler returns 502 -> Nothing persisted; retry with the same key re-executes", async () => {
    const store = createNamespacedStore("res-test-2");
    let attempts = 0;

    const handler = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        return NextResponse.json({ error: "SETTLEMENT_FAILED" }, { status: 502 });
      }
      return NextResponse.json({ status: "success" }, { status: 200 });
    });

    const res1 = await withIdempotency(postRequest("key-502"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res1.status).toBe(502);

    // Second request with same key should re-execute
    const res2 = await withIdempotency(postRequest("key-502"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res2.status).toBe(200);
    expect(attempts).toBe(2);
    expect(res2.headers.get("Idempotency-Replay")).toBe("false");
  });

  // Scenario 3: Handler throws
  // Reservation released; retry re-executes
  it("Scenario 3: Handler throws -> Reservation released; retry re-executes", async () => {
    const store = createNamespacedStore("res-test-3");
    let attempts = 0;

    const handler = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("RPC network timeout");
      }
      return NextResponse.json({ status: "recovered" }, { status: 200 });
    });

    await expect(
      withIdempotency(postRequest("key-throw"), "settle", store, handler, { resourceId: STREAM_ID })
    ).rejects.toThrow("RPC network timeout");

    // Retry with the same key should succeed and re-execute
    const res2 = await withIdempotency(postRequest("key-throw"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res2.status).toBe(200);
    expect(attempts).toBe(2);
  });

  // Scenario 4: Handler returns 409 INVALID_STREAM_STATE
  // Persisted; replay returns 409
  it("Scenario 4: Handler returns 409 INVALID_STREAM_STATE -> Persisted; replay returns 409", async () => {
    const store = createNamespacedStore("res-test-4");
    let handlerCalls = 0;

    const handler = jest.fn(async () => {
      handlerCalls++;
      return NextResponse.json(
        { error: { code: "STREAM_ALREADY_SETTLED", message: "Stream already ended" } },
        { status: 409 }
      );
    });

    const res1 = await withIdempotency(postRequest("key-409"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res1.status).toBe(409);
    expect(handlerCalls).toBe(1);

    // Replay with same key returns cached 409 without calling handler
    const res2 = await withIdempotency(postRequest("key-409"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res2.status).toBe(409);
    expect(res2.headers.get("Idempotency-Replay")).toBe("true");
    expect(handlerCalls).toBe(1);
  });

  // Scenario 5: Reservation older than the in-flight TTL
  // Next request takes over and executes
  it("Scenario 5: Reservation older than in-flight TTL -> Next request takes over and executes", async () => {
    const store = createNamespacedStore("res-test-5");

    // Manually plant an expired in_flight reservation
    const storeKey = `${STREAM_ID.length}:${STREAM_ID}:key-stale`;
    const staleTime = Date.now() - (IDEMPOTENCY_INFLIGHT_TTL_MS + 5000);
    await store.set(storeKey, {
      state: "in_flight",
      fingerprint: "old-fingerprint",
      reservedAt: staleTime,
      expiresAt: staleTime + IDEMPOTENCY_INFLIGHT_TTL_MS,
    } as any);

    let executed = false;
    const handler = jest.fn(async () => {
      executed = true;
      return NextResponse.json({ status: "taken_over" }, { status: 200 });
    });

    const res = await withIdempotency(postRequest("key-stale"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res.status).toBe(200);
    expect(executed).toBe(true);
    const body = await res.json();
    expect(body.status).toBe("taken_over");
  });

  // Scenario 6: Store get throws
  // 503 IDEMPOTENCY_STORE_UNAVAILABLE; handler not called
  it("Scenario 6: Store get throws -> 503 IDEMPOTENCY_STORE_UNAVAILABLE; handler not called", async () => {
    const faultyStore: IdempotencyStore = {
      async get() {
        throw new Error("Connection to database lost");
      },
      async set() {},
      async setIfAbsent() {
        return false;
      },
      async delete() {},
    };

    let handlerCalled = false;
    const handler = jest.fn(async () => {
      handlerCalled = true;
      return NextResponse.json({ status: "ok" });
    });

    const res = await withIdempotency(postRequest("key-store-down"), "settle", faultyStore, handler, { resourceId: STREAM_ID });
    expect(res.status).toBe(503);
    expect(handlerCalled).toBe(false);
    const body = await res.json();
    expect(body.error?.code).toBe("IDEMPOTENCY_STORE_UNAVAILABLE");
  });

  // Scenario 7: 429 from an inner rate limit
  // Not persisted
  it("Scenario 7: 429 from an inner rate limit -> Not persisted; retry executes handler", async () => {
    const store = createNamespacedStore("res-test-7");
    let attempts = 0;

    const handler = jest.fn(async () => {
      attempts++;
      if (attempts === 1) {
        return NextResponse.json({ error: "Too Many Requests" }, { status: 429 });
      }
      return NextResponse.json({ status: "ok" }, { status: 200 });
    });

    const res1 = await withIdempotency(postRequest("key-429"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res1.status).toBe(429);

    // Second request re-executes handler
    const res2 = await withIdempotency(postRequest("key-429"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res2.status).toBe(200);
    expect(attempts).toBe(2);
  });

  // Scenario 8: Committed 200, then a concurrent duplicate
  // Duplicate gets the 200 replay
  it("Scenario 8: Committed 200, then a concurrent duplicate -> Duplicate gets 200 replay", async () => {
    const store = createNamespacedStore("res-test-8");
    let handlerCalls = 0;

    const handler = jest.fn(async () => {
      handlerCalls++;
      return NextResponse.json({ data: "settle-ok" }, { status: 200 });
    });

    // Initial successful settlement
    const res1 = await withIdempotency(postRequest("key-committed"), "settle", store, handler, { resourceId: STREAM_ID });
    expect(res1.status).toBe(200);
    expect(handlerCalls).toBe(1);

    // Duplicate requests in parallel
    const [dup1, dup2] = await Promise.all([
      withIdempotency(postRequest("key-committed"), "settle", store, handler, { resourceId: STREAM_ID }),
      withIdempotency(postRequest("key-committed"), "settle", store, handler, { resourceId: STREAM_ID }),
    ]);

    expect(dup1.status).toBe(200);
    expect(dup2.status).toBe(200);
    expect(dup1.headers.get("Idempotency-Replay")).toBe("true");
    expect(dup2.headers.get("Idempotency-Replay")).toBe("true");
    expect(handlerCalls).toBe(1);
  });

  it("covers corrupted or expired record eviction in createNamespacedStore get", async () => {
    const store = createNamespacedStore("corrupted-test");
    const storeKey = `${STREAM_ID.length}:${STREAM_ID}:key-corrupted`;
    const backing = db.idempotency as any;
    
    // Malformed entry without string fingerprint
    backing.set("idempotency:corrupted-test:" + storeKey, { fingerprint: 123, expiresAt: Date.now() + 10000 });
    expect(await store.get(storeKey)).toBeNull();

    // Expired entry
    backing.set("idempotency:corrupted-test:" + storeKey, { fingerprint: "valid", expiresAt: Date.now() - 1000 });
    expect(await store.get(storeKey)).toBeNull();
  });

  it("covers plain string response body committing", async () => {
    const store = createNamespacedStore("plain-text-test");
    const res = await withIdempotency(postRequest("key-plain-text"), "settle", store, async () => new NextResponse("plain string response", { status: 200 }), { resourceId: STREAM_ID });
    expect(res.status).toBe(200);
    const replay = await withIdempotency(postRequest("key-plain-text"), "settle", store, async () => new NextResponse("fail", { status: 500 }), { resourceId: STREAM_ID });
    expect(replay.status).toBe(200);
  });

  it("covers in-flight reservation with mismatched fingerprint returning 409 IDEMPOTENCY_CONFLICT", async () => {
    const store = createNamespacedStore("res-conflict-test");
    const storeKey = `${STREAM_ID.length}:${STREAM_ID}:key-inflight-diff`;
    await store.set(storeKey, {
      state: "in_flight",
      fingerprint: "diff-fp",
      reservedAt: Date.now(),
      expiresAt: Date.now() + IDEMPOTENCY_INFLIGHT_TTL_MS,
    } as any);

    const res = await withIdempotency(postRequest("key-inflight-diff", { foo: "bar" }), "settle", store, async () => NextResponse.json({}), { resourceId: STREAM_ID });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("covers store.setIfAbsent throwing and failing closed with 503", async () => {
    const store: IdempotencyStore = {
      async get() { return null; },
      async set() {},
      async setIfAbsent() { throw new Error("Disk full"); },
      async delete() {},
    };

    const res = await withIdempotency(postRequest("key-set-fail"), "settle", store, async () => NextResponse.json({}), { resourceId: STREAM_ID });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error?.code).toBe("IDEMPOTENCY_STORE_UNAVAILABLE");
  });

  it("covers error logging on store.delete or store.set failures", async () => {
    const store: IdempotencyStore = {
      async get() { return null; },
      async set() { throw new Error("Write failed"); },
      async setIfAbsent() { return true; },
      async delete() { throw new Error("Delete failed"); },
    };

    // Handler returning 200: store.set throws, response still returned
    const res = await withIdempotency(postRequest("key-set-err"), "settle", store, async () => NextResponse.json({ ok: true }, { status: 200 }), { resourceId: STREAM_ID });
    expect(res.status).toBe(200);

    // Handler throwing: store.delete throws
    await expect(withIdempotency(postRequest("key-del-err"), "settle", store, async () => { throw new Error("Handler boom"); }, { resourceId: STREAM_ID })).rejects.toThrow("Handler boom");

    // Handler returning 500: store.delete throws
    const res500 = await withIdempotency(postRequest("key-500-err"), "settle", store, async () => NextResponse.json({}, { status: 500 }), { resourceId: STREAM_ID });
    expect(res500.status).toBe(500);
  });

});
