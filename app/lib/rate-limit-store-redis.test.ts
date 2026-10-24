/**
 * Tests for RedisRateLimitStore
 *
 * fetch is mocked to a fake Redis that emulates the Lua token-bucket script
 * synchronously so tests are deterministic without network I/O.
 *
 * Scenarios covered
 * ──────────────────
 * 1  Two store instances sharing one fake Redis — combined count equals limit, not 2×
 * 2  20 concurrent check() calls — exactly `limit` are allowed
 * 3  Redis timeout with FAIL_MODE=open — allowed, unavailable counter incremented
 * 4  Redis timeout with FAIL_MODE=closed — denied with retryAfter ≥ 1
 * 5  Redis returns 5xx — fail-mode path, no unhandled rejection
 * 6  Env vars absent — getRateLimitStore() returns InMemoryRateLimitStore
 * 7  Bucket refill over time (fake clock) — parity with InMemoryRateLimitStore
 * 8  Key format — starts with streampay:rl:v1: and TTL is set
 */

import {
  RedisRateLimitStore,
  KEY_PREFIX,
  setStoreUnavailableHook,
  type FailMode,
} from "./rate-limit-store-redis";
import { InMemoryRateLimitStore, getRateLimitStore, resetRateLimitStore } from "./rate-limit-store";

// ---------------------------------------------------------------------------
// Fake Redis — emulates the Lua token bucket in JavaScript
// ---------------------------------------------------------------------------

interface FakeBucket {
  tokens: number;
  lastRefill: number;
}

class FakeRedis {
  readonly buckets = new Map<string, FakeBucket>();
  readonly ttls = new Map<string, number>(); // seconds

  /**
   * Emulate EVAL TOKEN_BUCKET_LUA KEYS[1] ARGV[1..4]
   * Returns [allowed, remaining, resetAtMs]
   */
  eval(key: string, limit: number, windowMs: number, nowMs: number, ttlSeconds: number): [number, number, number] {
    this.ttls.set(key, ttlSeconds);
    const existing = this.buckets.get(key);

    if (!existing) {
      const remaining = limit - 1;
      this.buckets.set(key, { tokens: remaining, lastRefill: nowMs });
      return [1, remaining, nowMs + windowMs];
    }

    const elapsed = nowMs - existing.lastRefill;
    const refillRate = limit / windowMs;
    let newTokens = Math.min(existing.tokens + elapsed * refillRate, limit);

    if (newTokens >= 1) {
      newTokens -= 1;
      existing.tokens = newTokens;
      existing.lastRefill = nowMs;
      return [1, Math.floor(newTokens), nowMs + windowMs];
    }

    const msUntilToken = Math.ceil((1 - newTokens) / refillRate);
    existing.tokens = newTokens;
    existing.lastRefill = nowMs;
    return [0, 0, nowMs + msUntilToken];
  }
}

// ---------------------------------------------------------------------------
// Helper — build a mock fetch backed by a FakeRedis instance
// ---------------------------------------------------------------------------

function makeFetchMock(db: FakeRedis): jest.Mock {
  return jest.fn(async (url: string, init: RequestInit) => {
    // Parse the pipeline body: [[command, script, numKeys, ...keys, ...args]]
    const body = JSON.parse(init.body as string) as [string, ...string[]][];
    const cmd = body[0];
    // cmd = ["EVAL", script, numKeys, key, limit, windowMs, nowMs, ttl]
    const key = cmd[3];
    const limit = Number(cmd[4]);
    const windowMs = Number(cmd[5]);
    const nowMs = Number(cmd[6]);
    const ttlSeconds = Number(cmd[7]);

    const result = db.eval(key, limit, windowMs, nowMs, ttlSeconds);
    return {
      ok: true,
      status: 200,
      json: async () => [{ result }],
    } as unknown as Response;
  });
}

// ---------------------------------------------------------------------------
// Helpers — create a store with injected fetch + clock
// ---------------------------------------------------------------------------

function makeStore(
  db: FakeRedis,
  failMode: FailMode = "open",
  nowFn?: () => number
): RedisRateLimitStore {
  const store = new RedisRateLimitStore({
    redisUrl: "https://fake-redis.example.com",
    redisToken: "fake-token",
    failMode,
    nowFn,
  });
  // Patch the module-level fetch reference inside the closure by overriding
  // via jest mock on globalThis so the store's fetch call hits our stub.
  (store as any)._fetch = makeFetchMock(db);
  return store;
}

// ---------------------------------------------------------------------------
// Wire the fetch mock into the store's internal call
//
// RedisRateLimitStore uses the global fetch; we replace it before each test.
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function useFetchMock(db: FakeRedis): jest.Mock {
  const mock = makeFetchMock(db);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Two store instances sharing one fake Redis
//
// The combined allowed-request count across both stores must equal `limit`,
// not 2×limit.
// ---------------------------------------------------------------------------

describe("Scenario 1 — shared Redis: combined count equals limit, not 2×", () => {
  it("across two instances, exactly limit requests are allowed", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const LIMIT = 10;
    const WINDOW_MS = 60_000;
    const now = 1_700_000_000_000;

    const store1 = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => now,
    });
    const store2 = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => now,
    });

    // Alternate calls between the two stores
    const results = [];
    for (let i = 0; i < LIMIT * 2; i++) {
      const store = i % 2 === 0 ? store1 : store2;
      results.push(await store.check("user:alice", LIMIT, WINDOW_MS));
    }

    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    expect(allowed).toBe(LIMIT);
    expect(denied).toBe(LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — 20 concurrent check() calls: exactly `limit` are allowed
// ---------------------------------------------------------------------------

describe("Scenario 2 — concurrent calls: exactly limit allowed", () => {
  it("serialises concurrent calls via shared fake Redis", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const LIMIT = 5;
    const WINDOW_MS = 60_000;
    const now = 1_700_000_001_000;

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => now,
    });

    // Fire 20 concurrent calls; fake Redis is synchronous so ordering is FIFO
    const promises = Array.from({ length: 20 }, () =>
      store.check("user:bob", LIMIT, WINDOW_MS)
    );
    const results = await Promise.all(promises);

    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(LIMIT);
    expect(results.filter((r) => !r.allowed).length).toBe(20 - LIMIT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Redis timeout + FAIL_MODE=open
// ---------------------------------------------------------------------------

describe("Scenario 3 — Redis timeout, failMode=open", () => {
  it("allows the request and increments unavailable counter", async () => {
    // Replace global fetch with a mock that times out (aborts)
    globalThis.fetch = jest.fn(() => {
      return new Promise((_, reject) => {
        // Simulate AbortError from the 150ms timeout
        const err = new DOMException("The operation was aborted.", "AbortError");
        setTimeout(() => reject(err), 0);
      });
    }) as unknown as typeof fetch;

    let unavailableCount = 0;
    setStoreUnavailableHook(() => { unavailableCount++; });

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      failMode: "open",
      nowFn: () => 1_700_000_002_000,
    });

    const result = await store.check("user:carol", 10, 60_000);

    expect(result.allowed).toBe(true);
    expect(unavailableCount).toBe(1);
    expect(result.remaining).toBe(9); // limit - 1
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Redis timeout + FAIL_MODE=closed (login tier)
// ---------------------------------------------------------------------------

describe("Scenario 4 — Redis timeout, failMode=closed (login tier)", () => {
  it("denies after shadow bucket is exhausted, retryAfter >= 1", async () => {
    // Always timeout
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new DOMException("Aborted", "AbortError"))
    ) as unknown as typeof fetch;

    // Suppress counter noise for this test
    setStoreUnavailableHook(() => {});

    const LIMIT = 5; // login limit
    const WINDOW_MS = 60_000;
    let clock = 1_700_000_003_000;

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      failMode: "closed",
      nowFn: () => clock,
    });

    // Exhaust the shadow bucket (cap = min(LIMIT, 10) = 5)
    const results = [];
    for (let i = 0; i < LIMIT + 5; i++) {
      results.push(await store.check("user:dave", LIMIT, WINDOW_MS));
    }

    const denied = results.filter((r) => !r.allowed);
    expect(denied.length).toBeGreaterThan(0);

    const lastDenied = denied[denied.length - 1];
    expect(lastDenied.allowed).toBe(false);
    expect(lastDenied.retryAfter).toBeDefined();
    expect(lastDenied.retryAfter!).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Redis returns 5xx: no unhandled rejection, fail-mode path
// ---------------------------------------------------------------------------

describe("Scenario 5 — Redis returns 5xx", () => {
  it("enters fail-mode path without unhandled rejection", async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as unknown as Response)
    ) as unknown as typeof fetch;

    let unavailableCount = 0;
    setStoreUnavailableHook(() => { unavailableCount++; });

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      failMode: "open",
      nowFn: () => 1_700_000_004_000,
    });

    await expect(store.check("user:eve", 10, 60_000)).resolves.toMatchObject({
      allowed: true,
    });

    expect(unavailableCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Env vars absent: getRateLimitStore() returns InMemoryRateLimitStore
// ---------------------------------------------------------------------------

describe("Scenario 6 — env vars absent: in-memory store returned", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    resetRateLimitStore();
    process.env = { ...OLD_ENV };
    delete process.env.RATE_LIMIT_REDIS_URL;
    delete process.env.RATE_LIMIT_REDIS_TOKEN;
  });

  afterEach(() => {
    resetRateLimitStore();
    process.env = OLD_ENV;
  });

  it("returns InMemoryRateLimitStore when env vars are absent", () => {
    const store = getRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it("returns RedisRateLimitStore when both env vars are present", () => {
    process.env.RATE_LIMIT_REDIS_URL = "https://fake-redis.example.com";
    process.env.RATE_LIMIT_REDIS_TOKEN = "token";

    const store = getRateLimitStore();
    expect(store).toBeInstanceOf(RedisRateLimitStore);
  });

  it("returns InMemoryRateLimitStore when only URL is present", () => {
    process.env.RATE_LIMIT_REDIS_URL = "https://fake-redis.example.com";
    // no token
    const store = getRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Bucket refill over time (fake clock): parity with InMemory
// ---------------------------------------------------------------------------

describe("Scenario 7 — bucket refill parity with InMemoryRateLimitStore", () => {
  it("RedisRateLimitStore matches InMemory results for the same call sequence", async () => {
    // Use Jest fake timers so InMemoryRateLimitStore's Date.now() is controlled,
    // and keep a matching injectable clock for RedisRateLimitStore.
    jest.useFakeTimers();

    const BASE = Date.now(); // after fake timers are active, this is fixed
    let clock = BASE;

    const db = new FakeRedis();
    useFetchMock(db);

    const redisStore = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => clock,
    });
    const memStore = new InMemoryRateLimitStore();

    const LIMIT = 5;
    const WINDOW_MS = 60_000;
    const ID = "user:frank";

    try {
      // Exhaust both stores
      for (let i = 0; i < LIMIT; i++) {
        const r = await redisStore.check(ID, LIMIT, WINDOW_MS);
        const m = await memStore.check(ID, LIMIT, WINDOW_MS);
        expect(r.allowed).toBe(m.allowed);
      }

      // Both should now deny
      const rDenied = await redisStore.check(ID, LIMIT, WINDOW_MS);
      const mDenied = await memStore.check(ID, LIMIT, WINDOW_MS);
      expect(rDenied.allowed).toBe(false);
      expect(mDenied.allowed).toBe(false);

      // Advance both clocks by one full window — tokens fully refill
      clock += WINDOW_MS;
      jest.advanceTimersByTime(WINDOW_MS);

      const rRefilled = await redisStore.check(ID, LIMIT, WINDOW_MS);
      const mRefilled = await memStore.check(ID, LIMIT, WINDOW_MS);

      expect(rRefilled.allowed).toBe(true);
      expect(mRefilled.allowed).toBe(true);
    } finally {
      memStore.destroy();
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Key format: starts with streampay:rl:v1: and TTL is set
// ---------------------------------------------------------------------------

describe("Scenario 8 — key format and TTL", () => {
  it("uses streampay:rl:v1: prefix on Redis keys", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => 1_700_000_006_000,
    });

    await store.check("read:192.168.0.1", 60, 60_000);

    // The fake Redis captures the key from the parsed EVAL command
    const keys = Array.from(db.buckets.keys());
    expect(keys.length).toBe(1);
    expect(keys[0]).toBe(`${KEY_PREFIX}read:192.168.0.1`);
    expect(keys[0]).toMatch(/^streampay:rl:v1:/);
  });

  it("sets TTL to 2 × windowMs (in seconds)", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const WINDOW_MS = 60_000;
    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => 1_700_000_007_000,
    });

    await store.check("write:wallet123", 10, WINDOW_MS);

    const key = `${KEY_PREFIX}write:wallet123`;
    const ttl = db.ttls.get(key);
    expect(ttl).toBe((2 * WINDOW_MS) / 1000); // = 120 seconds
  });
});

// ---------------------------------------------------------------------------
// Bonus — RateLimitResult shape is preserved
// ---------------------------------------------------------------------------

describe("Result shape", () => {
  it("allowed result has required fields", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => 1_700_000_008_000,
    });

    const result = await store.check("user:grace", 10, 60_000);
    expect(result).toMatchObject({
      allowed: true,
      remaining: expect.any(Number),
      resetAt: expect.any(Number),
    });
    expect(result.retryAfter).toBeUndefined();
  });

  it("denied result has retryAfter >= 1", async () => {
    const db = new FakeRedis();
    useFetchMock(db);

    const LIMIT = 2;
    const now = 1_700_000_009_000;
    const store = new RedisRateLimitStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      nowFn: () => now,
    });

    for (let i = 0; i < LIMIT; i++) {
      await store.check("user:henry", LIMIT, 60_000);
    }
    const result = await store.check("user:henry", LIMIT, 60_000);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter!).toBeGreaterThanOrEqual(1);
    expect(result.resetAt).toBeGreaterThan(Math.floor(now / 1000));
  });
});
