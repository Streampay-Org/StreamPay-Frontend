import { recordEviction } from "./rate-limit-metrics";
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
  /** True when the store failed open (e.g. Redis outage) and limits could not be measured accurately. */
  degraded?: boolean;
}

export interface RateLimitStore {
  check(identifier: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/** Algorithm selector — defaults to token-bucket (unchanged behaviour). */
export type RateLimitAlgorithm = "token-bucket" | "sliding-window";

export function getRateLimitAlgorithm(): RateLimitAlgorithm {
  const env = process.env.RATE_LIMIT_ALGORITHM;
  if (env === "sliding-window") return "sliding-window";
  return "token-bucket";
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// ---------------------------------------------------------------------------
// Sliding-window counter
//
// Uses the weighted two-window approach: the current window and the previous
// window are tracked per identifier. The weighted count is:
//
//   weighted = prevCount * (1 - elapsedInCurrentWindow / windowMs) + currentCount
//
// This gives a smooth decay at the boundary so no more than `limit` requests
// are allowed in any rolling windowMs — including across a boundary.
// ---------------------------------------------------------------------------

interface SlidingWindowBucket {
  /** Count in the current window. */
  currentCount: number;
  /** Count in the previous window. */
  prevCount: number;
  /** Start timestamp (ms) of the current window. */
  windowStart: number;
}

export class SlidingWindowRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, SlidingWindowBucket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly maxBuckets: number;

  constructor(options?: { maxBuckets?: number }) {
    this.maxBuckets = options?.maxBuckets ?? 50_000;
    if (process.env.NODE_ENV !== "test" && typeof setInterval !== "undefined") {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }
  }

  getBucketCount(): number {
    return this.buckets.size;
  }

  async check(identifier: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(identifier);

    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.buckets.delete(oldestKey);
          recordEviction();
        }
      }
      // First request — start the window
      bucket = {
        currentCount: 1,
        prevCount: 0,
        windowStart: now,
      };
      this.buckets.set(identifier, bucket);
      return {
        allowed: true,
        remaining: limit - 1,
        resetAt: Math.floor((now + windowMs) / 1000),
      };
    }

    // Move to LRU position
    this.buckets.delete(identifier);
    this.buckets.set(identifier, bucket);

    // Check if we've moved into a new window
    const elapsed = now - bucket.windowStart;
    if (elapsed >= windowMs) {
      // We've passed the current window — shift it to prev
      // If more than 2 windows have passed, prev is effectively zero
      if (elapsed >= 2 * windowMs) {
        bucket.prevCount = 0;
        bucket.currentCount = 0;
      } else {
        bucket.prevCount = bucket.currentCount;
        bucket.currentCount = 0;
      }
      bucket.windowStart = now - (elapsed % windowMs);
    }

    // Compute weighted count
    const elapsedInCurrent = now - bucket.windowStart;
    const weightPrev = Math.max(0, 1 - elapsedInCurrent / windowMs);
    const weightedCount = bucket.prevCount * weightPrev + bucket.currentCount;

    if (weightedCount < limit) {
      bucket.currentCount += 1;
      const remaining = Math.max(0, Math.floor(limit - weightedCount - 1));
      // resetAt = when the oldest request in the current window expires
      const resetAtMs = bucket.windowStart + windowMs;
      return {
        allowed: true,
        remaining,
        resetAt: Math.floor(resetAtMs / 1000),
      };
    }

    // Rate limited — compute retryAfter
    const retryAfterMs = bucket.windowStart + windowMs - now;
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return {
      allowed: false,
      remaining: 0,
      resetAt: Math.floor((bucket.windowStart + windowMs) / 1000),
      retryAfter,
    };
  }

  cleanup(): void {
    const now = Date.now();
    // Keep buckets that had activity in the last 2 * windowMs (default 120s)
    const windowSize = 120_000;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.windowStart > windowSize) {
        this.buckets.delete(key);
      }
    }
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  destroy(): void {
    this.stopCleanup();
    this.buckets.clear();
  }
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly maxTokensPerBucket: number;
  private readonly maxBuckets: number;

  constructor(
    maxTokensPerBucket = 1000,
    options?: { maxBuckets?: number }
  ) {
    this.maxTokensPerBucket = maxTokensPerBucket;
    this.maxBuckets = options?.maxBuckets ?? 50_000;
    if (process.env.NODE_ENV !== "test" && typeof setInterval !== "undefined") {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
      this.cleanupInterval.unref?.();
    }
  }

  getBucketCount(): number {
    return this.buckets.size;
  }

  async check(identifier: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(identifier);

    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) {
          this.buckets.delete(oldestKey);
          recordEviction();
        }
      }
      const newBucket: Bucket = {
        tokens: limit - 1,
        lastRefill: now,
      };
      this.buckets.set(identifier, newBucket);
      return {
        allowed: true,
        remaining: limit - 1,
        resetAt: Math.floor((now + windowMs) / 1000),
      };
    }

    this.buckets.delete(identifier);
    this.buckets.set(identifier, bucket);

    const elapsed = now - bucket.lastRefill;
    const refillRate = limit / windowMs;
    const tokensToAdd = elapsed * refillRate;

    const newTokens = Math.min(bucket.tokens + tokensToAdd, limit);
    bucket.tokens = newTokens;
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetAt: Math.floor((now + windowMs) / 1000),
      };
    }

    const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / refillRate / 1000);
    const retryAfter = Math.max(1, retryAfterSeconds);
    return {
      allowed: false,
      remaining: 0,
      resetAt: Math.floor((now + retryAfter * 1000) / 1000),
      retryAfter,
    };
  }

  cleanup(): void {
    const now = Date.now();
    const windowSize = 120_000;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > windowSize) {
        this.buckets.delete(key);
      }
    }
  }

  /** Stop periodic cleanup without discarding the active rate-limit buckets. */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  destroy(): void {
    this.stopCleanup();
    this.buckets.clear();
  }
}

let globalStore: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (!globalStore) {
    const redisUrl = process.env.RATE_LIMIT_REDIS_URL;
    const redisToken = process.env.RATE_LIMIT_REDIS_TOKEN;

    if (redisUrl && redisToken) {
      // Lazy-import to keep the Edge bundle free of the module when Redis is
      // not configured.  We use a synchronous require here because
      // getRateLimitStore() is called in hot paths and must be synchronous.
      const { RedisRateLimitStore, setStoreUnavailableHook } = require(
        "./rate-limit-store-redis"
      ) as typeof import("./rate-limit-store-redis");

      // Wire up the Prometheus counter, but only in the Node runtime where
      // prom-client is available.  On Edge the hook remains a no-op.
      if (typeof process !== "undefined" && process.env.NEXT_RUNTIME !== "edge") {
        try {
          const { rateLimitStoreUnavailable } = require(
            "../../src/metrics/registry"
          ) as typeof import("../../src/metrics/registry");
          setStoreUnavailableHook(() => rateLimitStoreUnavailable.inc());
        } catch {
          // metrics module unavailable (e.g. during unit tests that stub registry)
        }
      }

      const failMode = (process.env.RATE_LIMIT_FAIL_MODE ?? "open") as
        | "open"
        | "closed";

      globalStore = new RedisRateLimitStore({ redisUrl, redisToken, failMode });
    } else {
      const algorithm = getRateLimitAlgorithm();
      if (algorithm === "sliding-window") {
        globalStore = new SlidingWindowRateLimitStore();
      } else {
        globalStore = new InMemoryRateLimitStore();
      }
      if (process.env.NODE_ENV === "test") {
        // Disable periodic cleanup during tests to avoid timeouts
        disableCleanupForTests();
      }
    }
  }
  return globalStore;
}

export function setRateLimitStore(store: RateLimitStore): void {
  globalStore = store;
}

export function resetRateLimitStore(): void {
  if (globalStore instanceof InMemoryRateLimitStore) {
    globalStore.destroy();
  }
  globalStore = null;
}

/** Disable the cleanup interval for test environments */
export function disableCleanupForTests(): void {
  if (globalStore instanceof InMemoryRateLimitStore) {
    globalStore.stopCleanup();
  }
}


