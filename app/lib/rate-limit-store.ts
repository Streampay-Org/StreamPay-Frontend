export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface RateLimitStore {
  check(identifier: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, Bucket>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly maxTokensPerBucket = 1000) {
    if (process.env.NODE_ENV !== "test" && typeof setInterval !== "undefined") {
      this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }
  }

  async check(identifier: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const bucket = this.buckets.get(identifier);

    if (!bucket) {
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
      globalStore = new InMemoryRateLimitStore();
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
  globalStore = null;
}

/** Disable the cleanup interval for test environments */
export function disableCleanupForTests(): void {
  if (globalStore instanceof InMemoryRateLimitStore) {
    globalStore.stopCleanup();
  }
}


