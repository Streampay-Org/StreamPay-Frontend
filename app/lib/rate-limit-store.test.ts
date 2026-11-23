import {
  InMemoryRateLimitStore,
  getRateLimitStore,
  setRateLimitStore,
  resetRateLimitStore,
  disableCleanupForTests,
  type RateLimitStore,
} from "./rate-limit-store";
import { recordEviction, resetMetrics } from "./rate-limit-metrics";

jest.mock("./rate-limit-metrics", () => ({
  ...jest.requireActual("./rate-limit-metrics"),
  recordEviction: jest.fn(),
}));

describe("InMemoryRateLimitStore", () => {
  let store: InMemoryRateLimitStore;
  const initialTime = 1_700_000_000_000;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(initialTime);
    (recordEviction as unknown as jest.Mock).mockClear();
    resetMetrics();
    resetRateLimitStore();
    store = new InMemoryRateLimitStore();
  });

  afterEach(() => {
    store.destroy();
    resetRateLimitStore();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe("Token refill timing and resetAt calculation", () => {
    it("refills tokens over time and allows another request when advance time by windowMs / limit", async () => {
      const limit = 10;
      const windowMs = 60_000;
      const id = "refill-test-user";

      // Consume initial limit
      for (let i = 0; i < limit; i++) {
        const res = await store.check(id, limit, windowMs);
        expect(res.allowed).toBe(true);
      }

      // Exhausted bucket is denied immediately at the same timestamp
      const exhausted = await store.check(id, limit, windowMs);
      expect(exhausted.allowed).toBe(false);
      expect(exhausted.remaining).toBe(0);

      // Advance by less than 1 token refill time: windowMs / limit / 2 (3000ms = 0.5 token)
      jest.advanceTimersByTime((windowMs / limit) / 2);
      const partialRefill = await store.check(id, limit, windowMs);
      expect(partialRefill.allowed).toBe(false);
      expect(partialRefill.remaining).toBe(0);

      // Advance the remaining time to reach exactly windowMs / limit (6000ms total = 1 token)
      jest.advanceTimersByTime((windowMs / limit) / 2);
      const refilled = await store.check(id, limit, windowMs);

      expect(refilled.allowed).toBe(true);
      expect(refilled.remaining).toBe(0);
      expect(refilled.resetAt).toBe(Math.floor((Date.now() + windowMs) / 1000));
    });

    it("caps refilled tokens at limit and does not accumulate beyond limit", async () => {
      const limit = 5;
      const windowMs = 50_000;
      const id = "cap-refill-user";

      // Consume 2 tokens
      await store.check(id, limit, windowMs);
      await store.check(id, limit, windowMs);

      // Advance past the full window
      jest.advanceTimersByTime(windowMs * 2);

      // Next request should see tokens refilled up to limit, so remaining is limit - 1
      const res = await store.check(id, limit, windowMs);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(limit - 1);
    });
  });

  describe("Denial result shape", () => {
    it("returns allowed: false, remaining: 0, and retryAfter >= 1 when limit is exceeded", async () => {
      const limit = 3;
      const windowMs = 30_000;
      const id = "denial-user";

      for (let i = 0; i < limit; i++) {
        await store.check(id, limit, windowMs);
      }

      const denial = await store.check(id, limit, windowMs);

      expect(denial.allowed).toBe(false);
      expect(denial.remaining).toBe(0);
      expect(typeof denial.retryAfter).toBe("number");
      expect(denial.retryAfter).toBeDefined();
      expect((denial.retryAfter as number) >= 1).toBe(true);
      expect(denial.resetAt).toBe(
        Math.floor((Date.now() + (denial.retryAfter as number) * 1000) / 1000),
      );
    });

    it("calculates exact retryAfter based on deficit and refillRate", async () => {
      const limit = 10;
      const windowMs = 60_000;
      const id = "retry-calc-user";

      for (let i = 0; i < limit; i++) {
        await store.check(id, limit, windowMs);
      }

      // At tokens = 0, refillRate = 10 / 60_000 = 1/6000 tokens/ms
      // (1 - 0) / (1/6000) = 6000ms -> ceil(6000 / 1000) = 6 seconds
      const denial = await store.check(id, limit, windowMs);
      expect(denial.retryAfter).toBe(6);
    });
  });

  describe("maxBuckets cap and eviction", () => {
    it("evicts oldest key when maxBuckets is reached and calls recordEviction", async () => {
      const cappedStore = new InMemoryRateLimitStore(1000, { maxBuckets: 2 });
      try {
        expect(cappedStore.getBucketCount()).toBe(0);

        await cappedStore.check("key-1", 5, 60_000);
        expect(cappedStore.getBucketCount()).toBe(1);

        await cappedStore.check("key-2", 5, 60_000);
        expect(cappedStore.getBucketCount()).toBe(2);

        // Adding a third key triggers eviction of the oldest (key-1)
        await cappedStore.check("key-3", 5, 60_000);
        expect(cappedStore.getBucketCount()).toBe(2);
        expect(recordEviction).toHaveBeenCalledTimes(1);

        // key-1 was evicted; checking it creates a new bucket with fresh remaining = limit - 1
        const freshKey1 = await cappedStore.check("key-1", 5, 60_000);
        expect(freshKey1.remaining).toBe(4);
        expect(cappedStore.getBucketCount()).toBe(2);
        expect(recordEviction).toHaveBeenCalledTimes(2);
      } finally {
        cappedStore.destroy();
      }
    });

    it("supports LRU re-ordering so touching an existing key protects it from eviction", async () => {
      const lruStore = new InMemoryRateLimitStore(1000, { maxBuckets: 2 });
      try {
        await lruStore.check("key-A", 10, 60_000); // Remaining: 9
        await lruStore.check("key-B", 10, 60_000); // Remaining: 9

        // Touch key-A again to promote it to most-recently used
        const touchA = await lruStore.check("key-A", 10, 60_000);
        expect(touchA.remaining).toBe(8);

        // Add key-C; oldest is now key-B (not key-A)
        await lruStore.check("key-C", 10, 60_000);
        expect(lruStore.getBucketCount()).toBe(2);
        expect(recordEviction).toHaveBeenCalledTimes(1);

        // key-A is still present with its updated token count (decremented to 7)
        const checkA = await lruStore.check("key-A", 10, 60_000);
        expect(checkA.remaining).toBe(7);

        // key-B was evicted, so checking it starts fresh with remaining: limit - 1 = 9
        const checkB = await lruStore.check("key-B", 10, 60_000);
        expect(checkB.remaining).toBe(9);
      } finally {
        lruStore.destroy();
      }
    });
  });

  describe("cleanup and lifecycle methods", () => {
    it("removes buckets idle > 120s but keeps recent ones", async () => {
      await store.check("idle-key", 10, 60_000);

      // 60 seconds later, touch active-key
      jest.advanceTimersByTime(60_000);
      await store.check("active-key", 10, 60_000);
      expect(store.getBucketCount()).toBe(2);

      // Advance by another 60_001 ms (total 120_001 ms for idle-key, 60_001 ms for active-key)
      jest.advanceTimersByTime(60_001);

      store.cleanup();

      // Only active-key remains
      expect(store.getBucketCount()).toBe(1);

      // active-key is preserved in store: checking it does not increment bucket count
      await store.check("active-key", 10, 60_000);
      expect(store.getBucketCount()).toBe(1);

      // idle-key was cleaned up: checking it creates a new bucket and increments bucket count to 2
      await store.check("idle-key", 10, 60_000);
      expect(store.getBucketCount()).toBe(2);
    });

    it("retains buckets idle <= 120s during cleanup", async () => {
      await store.check("boundary-key", 10, 60_000);
      jest.advanceTimersByTime(120_000);

      store.cleanup();
      expect(store.getBucketCount()).toBe(1);
    });

    it("stopCleanup and destroy are idempotent", () => {
      // Calling on an uninitialized cleanup interval
      expect(() => store.stopCleanup()).not.toThrow();
      expect(() => store.stopCleanup()).not.toThrow();

      expect(() => store.destroy()).not.toThrow();
      expect(() => store.destroy()).not.toThrow();
      expect(store.getBucketCount()).toBe(0);

      // With an active cleanup interval simulated in non-test environment
      const originalEnv = process.env.NODE_ENV;
      try {
        (process.env as Record<string, string | undefined>).NODE_ENV = "production";
        const prodStore = new InMemoryRateLimitStore();

        expect(() => prodStore.stopCleanup()).not.toThrow();
        expect(() => prodStore.stopCleanup()).not.toThrow();

        expect(() => prodStore.destroy()).not.toThrow();
        expect(() => prodStore.destroy()).not.toThrow();
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
      }
    });

    it("disableCleanupForTests only affects an in-memory global store", () => {
      // Case 1: in-memory global store
      const inMemoryGlobal = new InMemoryRateLimitStore();
      const stopSpy = jest.spyOn(inMemoryGlobal, "stopCleanup");
      setRateLimitStore(inMemoryGlobal);

      disableCleanupForTests();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      inMemoryGlobal.destroy();

      // Case 2: foreign non-InMemoryRateLimitStore instance
      const foreignStore: RateLimitStore = {
        check: jest.fn(),
      };
      setRateLimitStore(foreignStore);

      expect(() => disableCleanupForTests()).not.toThrow();

      // Case 3: globalStore is null
      resetRateLimitStore();
      expect(() => disableCleanupForTests()).not.toThrow();
    });

    it("getRateLimitStore falls back to InMemoryRateLimitStore and invokes disableCleanupForTests in test env", () => {
      delete process.env.RATE_LIMIT_REDIS_URL;
      delete process.env.RATE_LIMIT_REDIS_TOKEN;

      const defaultStore = getRateLimitStore();
      expect(defaultStore).toBeInstanceOf(InMemoryRateLimitStore);
      expect((defaultStore as InMemoryRateLimitStore).getBucketCount()).toBe(0);
    });
  });

  describe("Edge cases", () => {
    it("handles limit = 1 correctly", async () => {
      const id = "single-token-user";
      const windowMs = 10_000;

      // First request uses the 1 available token
      const first = await store.check(id, 1, windowMs);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(0);

      // Immediate second request is denied
      const second = await store.check(id, 1, windowMs);
      expect(second.allowed).toBe(false);
      expect(second.remaining).toBe(0);
      expect(second.retryAfter).toBe(10);

      // Advance by full window to refill the 1 token
      jest.advanceTimersByTime(windowMs);
      const third = await store.check(id, 1, windowMs);
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(0);
    });

    it("handles very small windowMs correctly", async () => {
      const id = "small-window-user";
      const limit = 5;
      const windowMs = 10; // 0.5 token per ms

      for (let i = 0; i < limit; i++) {
        await store.check(id, limit, windowMs);
      }

      const denied = await store.check(id, limit, windowMs);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBe(1);

      // Advance 2ms (2ms * 0.5 = 1 token refilled)
      jest.advanceTimersByTime(2);
      const refilled = await store.check(id, limit, windowMs);
      expect(refilled.allowed).toBe(true);
    });
  });
});
