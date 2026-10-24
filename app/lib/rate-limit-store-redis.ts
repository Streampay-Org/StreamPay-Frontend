/**
 * Redis-backed RateLimitStore
 *
 * Uses the Upstash REST API (or any compatible endpoint) so the same code
 * runs on the Node.js runtime and the Edge runtime without a native TCP
 * dependency.  The token bucket is advanced atomically with a single Lua
 * EVAL so concurrent Vercel instances never double-spend a token.
 *
 * Failure policy
 * ──────────────
 * Each tier declares RATE_LIMIT_FAIL_MODE=open|closed (default open).
 * When the remote call times out or returns a 5xx:
 *   - open  → allow the request (fail open)
 *   - closed → consult the local shadow bucket; deny only when it too is empty
 *
 * The local shadow bucket is intentionally conservative: it caps at
 * `SHADOW_CAPACITY` tokens so that a full Redis outage cannot be exploited
 * indefinitely by a single caller.
 */

import type { RateLimitStore, RateLimitResult } from "./rate-limit-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Key namespace shared across all application instances. */
export const KEY_PREFIX = "streampay:rl:v1:";

/** Hard cap on the shadow bucket when Redis is unavailable. */
const SHADOW_CAPACITY = 10;

/** Per-call Redis timeout in milliseconds. */
const REDIS_TIMEOUT_MS = 150;

// ---------------------------------------------------------------------------
// Lua token-bucket script
//
// KEYS[1]  = hash key for this bucket   (e.g. streampay:rl:v1:read:1.2.3.4)
// ARGV[1]  = limit                      (integer, number of tokens per window)
// ARGV[2]  = windowMs                   (integer, window length in ms)
// ARGV[3]  = nowMs                      (integer, current epoch ms from caller)
// ARGV[4]  = ttlSeconds                 (integer, 2×window, for EXPIRE)
//
// Returns an array: { allowed, remaining, resetAtMs }
//   allowed    = 1 (allow) or 0 (deny)
//   remaining  = integer tokens left after this call
//   resetAtMs  = epoch-ms when the bucket will be full again
// ---------------------------------------------------------------------------
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local limit    = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local nowMs    = tonumber(ARGV[3])
local ttl      = tonumber(ARGV[4])

local data     = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens   = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  -- First request: initialise bucket, consume one token immediately
  local remaining = limit - 1
  redis.call("HMSET", key, "tokens", remaining, "lastRefill", nowMs)
  redis.call("EXPIRE", key, ttl)
  return {1, remaining, nowMs + windowMs}
end

-- Refill proportionally to elapsed time
local elapsed     = nowMs - lastRefill
local refillRate  = limit / windowMs          -- tokens per ms
local newTokens   = math.min(tokens + elapsed * refillRate, limit)

if newTokens >= 1 then
  newTokens = newTokens - 1
  redis.call("HMSET", key, "tokens", newTokens, "lastRefill", nowMs)
  redis.call("EXPIRE", key, ttl)
  return {1, math.floor(newTokens), nowMs + windowMs}
end

-- Bucket empty — calculate time until 1 token is available
local msUntilToken = math.ceil((1 - newTokens) / refillRate)
redis.call("HMSET", key, "tokens", newTokens, "lastRefill", nowMs)
redis.call("EXPIRE", key, ttl)
return {0, 0, nowMs + msUntilToken}
`;

// ---------------------------------------------------------------------------
// Shadow (local fallback) bucket
// ---------------------------------------------------------------------------

interface ShadowBucket {
  tokens: number;
  lastRefill: number;
}

function shadowCheck(
  buckets: Map<string, ShadowBucket>,
  identifier: string,
  limit: number,
  windowMs: number,
  now: number
): RateLimitResult {
  const cap = Math.min(limit, SHADOW_CAPACITY);
  const existing = buckets.get(identifier);

  if (!existing) {
    buckets.set(identifier, { tokens: cap - 1, lastRefill: now });
    return {
      allowed: true,
      remaining: cap - 1,
      resetAt: Math.floor((now + windowMs) / 1000),
    };
  }

  const elapsed = now - existing.lastRefill;
  const refillRate = cap / windowMs;
  const newTokens = Math.min(existing.tokens + elapsed * refillRate, cap);
  existing.lastRefill = now;

  if (newTokens >= 1) {
    existing.tokens = newTokens - 1;
    return {
      allowed: true,
      remaining: Math.floor(existing.tokens),
      resetAt: Math.floor((now + windowMs) / 1000),
    };
  }

  existing.tokens = newTokens;
  const retryAfterSeconds = Math.max(1, Math.ceil((1 - newTokens) / refillRate / 1000));
  return {
    allowed: false,
    remaining: 0,
    resetAt: Math.floor((now + retryAfterSeconds * 1000) / 1000),
    retryAfter: retryAfterSeconds,
  };
}

// ---------------------------------------------------------------------------
// Metrics hook (decoupled to avoid hard import cycle)
// ---------------------------------------------------------------------------

type UnavailableFn = () => void;
let _onUnavailable: UnavailableFn | null = null;

/** Inject the metrics callback at application startup (called by rate-limit-store.ts). */
export function setStoreUnavailableHook(fn: UnavailableFn): void {
  _onUnavailable = fn;
}

function recordUnavailable(): void {
  try {
    _onUnavailable?.();
  } catch {
    // never let a metrics error propagate
  }
}

// ---------------------------------------------------------------------------
// Upstash REST API helpers
// ---------------------------------------------------------------------------

interface UpstashResponse {
  result?: unknown;
  error?: string;
}

/**
 * Execute a single Redis command via the Upstash REST API pipeline endpoint.
 *
 * The pipeline endpoint accepts an array of commands and returns an array of
 * results in the same order.  We wrap each EVAL here.
 */
async function redisEval(
  url: string,
  token: string,
  keys: string[],
  args: (string | number)[],
  nowFn: () => number
): Promise<[number, number, number]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);

  const body = JSON.stringify([
    [
      "EVAL",
      TOKEN_BUCKET_LUA,
      String(keys.length),
      ...keys,
      ...args.map(String),
    ],
  ]);

  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Redis HTTP ${res.status}`);
    }

    const json = (await res.json()) as UpstashResponse[];
    const first = json[0];

    if (first?.error) {
      throw new Error(`Redis error: ${first.error}`);
    }

    const result = first?.result as [number, number, number];
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// RedisRateLimitStore
// ---------------------------------------------------------------------------

export type FailMode = "open" | "closed";

export interface RedisRateLimitStoreOptions {
  /** Upstash (or compatible) REST URL, e.g. https://your-db.upstash.io */
  redisUrl: string;
  /** Upstash REST API token (Bearer). */
  redisToken: string;
  /**
   * Behaviour when the Redis call fails.
   *   open   – allow the request (default for read/low-sensitivity tiers)
   *   closed – consult local shadow bucket; deny when shadow is empty too
   */
  failMode?: FailMode;
  /**
   * Inject a custom clock function for deterministic testing.
   * Defaults to Date.now.
   */
  nowFn?: () => number;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redisUrl: string;
  private readonly redisToken: string;
  private readonly failMode: FailMode;
  private readonly nowFn: () => number;

  /** Per-instance shadow buckets used during outages (closed mode). */
  private readonly shadow = new Map<string, ShadowBucket>();

  constructor(options: RedisRateLimitStoreOptions) {
    this.redisUrl = options.redisUrl.replace(/\/$/, ""); // strip trailing slash
    this.redisToken = options.redisToken;
    this.failMode = options.failMode ?? "open";
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  async check(
    identifier: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult> {
    const now = this.nowFn();
    const key = `${KEY_PREFIX}${identifier}`;
    const ttlSeconds = Math.ceil((2 * windowMs) / 1000);

    try {
      const [allowed, remaining, resetAtMs] = await redisEval(
        this.redisUrl,
        this.redisToken,
        [key],
        [limit, windowMs, now, ttlSeconds],
        this.nowFn
      );

      if (allowed === 1) {
        return {
          allowed: true,
          remaining,
          resetAt: Math.floor(resetAtMs / 1000),
        };
      }

      // Bucket exhausted
      const resetAtSec = Math.floor(resetAtMs / 1000);
      const nowSec = Math.floor(now / 1000);
      const retryAfter = Math.max(1, resetAtSec - nowSec);

      return {
        allowed: false,
        remaining: 0,
        resetAt: resetAtSec,
        retryAfter,
      };
    } catch (err) {
      // Redis is unavailable — increment the metric counter
      recordUnavailable();

      if (this.failMode === "open") {
        // Optimistic: let the request through
        return {
          allowed: true,
          remaining: limit - 1,
          resetAt: Math.floor((now + windowMs) / 1000),
        };
      }

      // failMode === "closed": use local shadow bucket
      return shadowCheck(this.shadow, identifier, limit, windowMs, now);
    }
  }

  /** Expose the shadow bucket map for testing. */
  _shadowBuckets(): Map<string, ShadowBucket> {
    return this.shadow;
  }
}
