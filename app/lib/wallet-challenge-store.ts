/**
 * Pluggable Wallet Challenge Store
 *
 * Stores short-lived, single-use wallet authentication challenges issued by
 * `GET /api/auth/wallet` and consumed by `POST /api/auth/wallet`.
 *
 * Implementations:
 *   - `InMemoryWalletChallengeStore`: single-process Map-backed store with
 *     per-address cap (default 5, oldest evicted), global cap
 *     (`WALLET_CHALLENGE_MAX`, default 10 000), and O(expired) TTL pruning.
 *   - `RedisWalletChallengeStore`: shared Upstash-compatible REST Redis store
 *     using atomic Lua scripts for issuance (with per-address cap eviction and
 *     PX TTL) and single-use consumption (atomic lookup + delete).
 *
 * Failure Policy (Redis outage)
 * ─────────────────────────────
 * Challenge verification MUST fail closed. If Redis is unreachable, times out,
 * or returns an error during `issue()` or `consume()`, `RedisWalletChallengeStore`
 * throws `WalletChallengeStoreUnavailableError`. The wallet auth route catches
 * this and responds with HTTP 503 (canonical error envelope) — it never accepts
 * an unverifiable challenge and never falls back to a local in-memory bypass.
 */

import { timingSafeEqual } from "crypto";

// ── Types & constants ─────────────────────────────────────────────────────────

export interface WalletChallengeRecord {
  id: string;
  address: string;
  challenge: string;
  created_at: string;
  expires_at: string;
}

export interface WalletChallengeStore {
  issue(record: WalletChallengeRecord): Promise<void>;
  consume(address: string, challenge: string): Promise<WalletChallengeRecord | null>;
  pruneExpired(nowMs?: number): Promise<void>;
}

/** Challenge lifetime: 5 minutes from issuance. */
export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Live challenges kept per address; the oldest is evicted first. */
export const WALLET_CHALLENGE_PER_ADDRESS_MAX = 5;

/** Default global cap for the in-memory store; overridable via WALLET_CHALLENGE_MAX. */
export const DEFAULT_WALLET_CHALLENGE_MAX = 10_000;

/** Key prefix for Redis wallet challenge records. */
export const WALLET_CHALLENGE_KEY_PREFIX = "streampay:wallet-challenge:v1:";

/** Per-call Redis timeout in milliseconds. */
export const WALLET_CHALLENGE_REDIS_TIMEOUT_MS = 500;

/**
 * Thrown when the backing challenge store (e.g. Redis) is unavailable or
 * returns an unexpected error. Callers MUST fail closed (reject with 503).
 */
export class WalletChallengeStoreUnavailableError extends Error {
  readonly code = "WALLET_CHALLENGE_STORE_UNAVAILABLE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WalletChallengeStoreUnavailableError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function resolveWalletChallengeMax(): number {
  const raw = process.env.WALLET_CHALLENGE_MAX;
  if (!raw) return DEFAULT_WALLET_CHALLENGE_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WALLET_CHALLENGE_MAX;
}

export function buildChallengeRecordKey(address: string, id: string): string {
  return `${WALLET_CHALLENGE_KEY_PREFIX}${address}:${id}`;
}

export function buildAddressIndexKey(address: string): string {
  return `${WALLET_CHALLENGE_KEY_PREFIX}addr:${address}`;
}

// ── In-memory implementation ──────────────────────────────────────────────────

export interface InMemoryWalletChallengeStoreOptions {
  perAddressMax?: number;
  globalMax?: () => number;
  nowFn?: () => number;
}

/**
 * Single-process Map-backed challenge store.
 *
 * Records are stored in insertion order. Because all issued challenges share
 * the same TTL, insertion order matches expiry order and `pruneExpired` only
 * walks the expired prefix.
 */
export class InMemoryWalletChallengeStore implements WalletChallengeStore {
  private readonly records = new Map<string, WalletChallengeRecord>();
  private readonly idsByAddress = new Map<string, Set<string>>();
  private readonly perAddressMax: number;
  private readonly globalMaxFn: () => number;
  private readonly nowFn: () => number;

  constructor(options: InMemoryWalletChallengeStoreOptions = {}) {
    this.perAddressMax = options.perAddressMax ?? WALLET_CHALLENGE_PER_ADDRESS_MAX;
    this.globalMaxFn = options.globalMax ?? resolveWalletChallengeMax;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private deleteRecord(record: WalletChallengeRecord): void {
    this.records.delete(record.id);
    const ids = this.idsByAddress.get(record.address);
    if (!ids) return;
    ids.delete(record.id);
    if (ids.size === 0) this.idsByAddress.delete(record.address);
  }

  async pruneExpired(nowMs: number = this.nowFn()): Promise<void> {
    for (const record of this.records.values()) {
      if (Date.parse(record.expires_at) > nowMs) break;
      this.deleteRecord(record);
    }
  }

  async issue(record: WalletChallengeRecord): Promise<void> {
    const nowMs = this.nowFn();
    await this.pruneExpired(nowMs);

    // Per-address cap: keep only the newest `perAddressMax`.
    const ids = this.idsByAddress.get(record.address) ?? new Set<string>();
    while (ids.size >= this.perAddressMax) {
      const oldestId = ids.values().next().value;
      if (oldestId === undefined) break;
      const oldest = this.records.get(oldestId);
      if (oldest) {
        this.deleteRecord(oldest);
      } else {
        ids.delete(oldestId);
      }
    }

    this.records.set(record.id, record);
    ids.add(record.id);
    this.idsByAddress.set(record.address, ids);

    // Global cap: evict oldest-first until within budget.
    const max = this.globalMaxFn();
    while (this.records.size > max) {
      const oldestId = this.records.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = this.records.get(oldestId);
      if (oldest) this.deleteRecord(oldest);
    }
  }

  /**
   * Atomically look up and remove the matching challenge.
   *
   * Searches by constant-time challenge comparison so callers can distinguish
   * `CHALLENGE_ADDRESS_MISMATCH` from `CHALLENGE_UNKNOWN` while still
   * consuming the challenge on the first verification attempt.
   */
  async consume(
    _address: string,
    challenge: string,
  ): Promise<WalletChallengeRecord | null> {
    let matched: WalletChallengeRecord | undefined;
    for (const candidate of this.records.values()) {
      if (timingSafeEqualStrings(candidate.challenge, challenge)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) return null;

    this.deleteRecord(matched);
    return matched;
  }

  // ── Testing helpers ─────────────────────────────────────────────────────────

  clear(): void {
    this.records.clear();
    this.idsByAddress.clear();
  }

  size(): number {
    return this.records.size;
  }

  listChallenges(): string[] {
    return Array.from(this.records.values(), (record) => record.challenge);
  }

  /** Insert a record directly without pruning (for seeding expired challenges in tests). */
  seed(record: WalletChallengeRecord): void {
    this.records.set(record.id, record);
    const ids = this.idsByAddress.get(record.address) ?? new Set<string>();
    ids.add(record.id);
    this.idsByAddress.set(record.address, ids);
  }
}

// ── Redis implementation (Upstash REST API) ───────────────────────────────────

/**
 * Lua script: atomically prune expired entries for an address, evict oldest
 * entries above `perAddressMax`, store the new challenge with PX TTL, and
 * update the per-address sorted set.
 *
 * KEYS[1] = per-address sorted set key (`streampay:wallet-challenge:v1:addr:<address>`)
 * KEYS[2] = new record key (`streampay:wallet-challenge:v1:<address>:<id>`)
 * ARGV[1] = record id
 * ARGV[2] = serialized record payload (`<challenge>\n<json>`)
 * ARGV[3] = nowMs
 * ARGV[4] = expiresAtMs
 * ARGV[5] = ttlMs
 * ARGV[6] = perAddressMax
 * ARGV[7] = record key prefix (`streampay:wallet-challenge:v1:<address>:`)
 */
export const ISSUE_CHALLENGE_LUA = `
local zkey       = KEYS[1]
local rkey       = KEYS[2]
local id         = ARGV[1]
local payload    = ARGV[2]
local nowMs      = tonumber(ARGV[3])
local expiresMs  = tonumber(ARGV[4])
local ttlMs      = tonumber(ARGV[5])
local maxPerAddr = tonumber(ARGV[6])
local keyPrefix  = ARGV[7]

-- Prune expired members from the per-address sorted set
local expired = redis.call("ZRANGEBYSCORE", zkey, "-inf", nowMs)
for _, oldId in ipairs(expired) do
  redis.call("DEL", keyPrefix .. oldId)
  redis.call("ZREM", zkey, oldId)
end

-- Enforce per-address cap by evicting oldest-expiring entries first
local count = redis.call("ZCARD", zkey)
if count >= maxPerAddr then
  local toEvict = count - maxPerAddr + 1
  local oldest = redis.call("ZRANGE", zkey, 0, toEvict - 1)
  for _, oldId in ipairs(oldest) do
    redis.call("DEL", keyPrefix .. oldId)
    redis.call("ZREM", zkey, oldId)
  end
end

-- Store new challenge record with PX TTL and index it
redis.call("SET", rkey, payload, "PX", ttlMs)
redis.call("ZADD", zkey, expiresMs, id)
local currentPttl = redis.call("PTTL", zkey)
if currentPttl < ttlMs then
  redis.call("PEXPIRE", zkey, ttlMs)
end
return 1
`;

/**
 * Lua script: atomically find the matching challenge for `address`, delete it
 * (single-use), remove it from the per-address sorted set, and return the
 * serialized record JSON. Returns nil if not found or already consumed.
 *
 * KEYS[1] = per-address sorted set key (`streampay:wallet-challenge:v1:addr:<address>`)
 * ARGV[1] = challenge string to match
 * ARGV[2] = record key prefix (`streampay:wallet-challenge:v1:<address>:`)
 */
export const CONSUME_CHALLENGE_LUA = `
local zkey      = KEYS[1]
local challenge = ARGV[1]
local keyPrefix = ARGV[2]

local ids = redis.call("ZRANGE", zkey, 0, -1)
for _, id in ipairs(ids) do
  local rkey = keyPrefix .. id
  local payload = redis.call("GET", rkey)
  if not payload then
    redis.call("ZREM", zkey, id)
  else
    local nl = string.find(payload, "\\n", 1, true)
    if nl then
      local storedChallenge = string.sub(payload, 1, nl - 1)
      if storedChallenge == challenge then
        redis.call("DEL", rkey)
        redis.call("ZREM", zkey, id)
        return string.sub(payload, nl + 1)
      end
    end
  end
end

return nil
`;

interface UpstashPipelineEntry {
  result?: unknown;
  error?: string;
}

export interface RedisWalletChallengeStoreOptions {
  /** Upstash (or compatible) REST URL, e.g. https://your-db.upstash.io */
  redisUrl: string;
  /** Upstash REST API Bearer token. */
  redisToken: string;
  /** Per-address cap (defaults to WALLET_CHALLENGE_PER_ADDRESS_MAX = 5). */
  perAddressMax?: number;
  /** Per-call timeout in ms (defaults to WALLET_CHALLENGE_REDIS_TIMEOUT_MS = 500). */
  timeoutMs?: number;
  /** Custom clock for deterministic testing. */
  nowFn?: () => number;
  /** Custom fetch implementation for testing. */
  fetchFn?: typeof fetch;
}

export class RedisWalletChallengeStore implements WalletChallengeStore {
  private readonly redisUrl: string;
  private readonly redisToken: string;
  private readonly perAddressMax: number;
  private readonly timeoutMs: number;
  private readonly nowFn: () => number;
  private readonly fetchFn: typeof fetch;

  constructor(options: RedisWalletChallengeStoreOptions) {
    this.redisUrl = options.redisUrl.replace(/\/$/, "");
    this.redisToken = options.redisToken;
    this.perAddressMax = options.perAddressMax ?? WALLET_CHALLENGE_PER_ADDRESS_MAX;
    this.timeoutMs = options.timeoutMs ?? WALLET_CHALLENGE_REDIS_TIMEOUT_MS;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async evalLua(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const body = JSON.stringify([
      [
        "EVAL",
        script,
        String(keys.length),
        ...keys,
        ...args.map(String),
      ],
    ]);

    try {
      const res = await this.fetchFn(`${this.redisUrl}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new WalletChallengeStoreUnavailableError(
          `Redis HTTP ${res.status}`,
        );
      }

      const json = (await res.json()) as UpstashPipelineEntry[];
      const first = json[0];

      if (first?.error) {
        throw new WalletChallengeStoreUnavailableError(
          `Redis error: ${first.error}`,
        );
      }

      return first?.result ?? null;
    } catch (error) {
      if (error instanceof WalletChallengeStoreUnavailableError) {
        throw error;
      }
      throw new WalletChallengeStoreUnavailableError(
        error instanceof Error ? error.message : "Redis request failed",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async issue(record: WalletChallengeRecord): Promise<void> {
    const nowMs = this.nowFn();
    const expiresAtMs = Date.parse(record.expires_at);
    const ttlMs = Math.max(1, expiresAtMs - nowMs);
    const zkey = buildAddressIndexKey(record.address);
    const rkey = buildChallengeRecordKey(record.address, record.id);
    const keyPrefix = `${WALLET_CHALLENGE_KEY_PREFIX}${record.address}:`;
    const payload = `${record.challenge}\n${JSON.stringify(record)}`;

    await this.evalLua(
      ISSUE_CHALLENGE_LUA,
      [zkey, rkey],
      [
        record.id,
        payload,
        nowMs,
        expiresAtMs,
        ttlMs,
        this.perAddressMax,
        keyPrefix,
      ],
    );
  }

  async consume(
    address: string,
    challenge: string,
  ): Promise<WalletChallengeRecord | null> {
    const zkey = buildAddressIndexKey(address);
    const keyPrefix = `${WALLET_CHALLENGE_KEY_PREFIX}${address}:`;

    const raw = await this.evalLua(
      CONSUME_CHALLENGE_LUA,
      [zkey],
      [challenge, keyPrefix],
    );

    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }

    try {
      return JSON.parse(raw) as WalletChallengeRecord;
    } catch (error) {
      throw new WalletChallengeStoreUnavailableError(
        "Corrupt wallet challenge record in Redis",
        { cause: error },
      );
    }
  }

  async pruneExpired(_nowMs?: number): Promise<void> {
    // Redis handles record expiry natively via PX TTL and per-address sorted
    // set cleanup runs atomically on every issue() and consume() call.
  }
}

// ── Factory & process singleton ───────────────────────────────────────────────

/**
 * Build a `WalletChallengeStore` from environment variables.
 *
 * Uses `WALLET_CHALLENGE_REDIS_URL` / `WALLET_CHALLENGE_REDIS_TOKEN` when set,
 * falling back to `RATE_LIMIT_REDIS_URL` / `RATE_LIMIT_REDIS_TOKEN`. When
 * neither pair is configured, returns an `InMemoryWalletChallengeStore`.
 */
export function createWalletChallengeStore(
  env: NodeJS.ProcessEnv = process.env,
): WalletChallengeStore {
  const redisUrl =
    env.WALLET_CHALLENGE_REDIS_URL?.trim() ||
    env.RATE_LIMIT_REDIS_URL?.trim();
  const redisToken =
    env.WALLET_CHALLENGE_REDIS_TOKEN?.trim() ||
    env.RATE_LIMIT_REDIS_TOKEN?.trim();

  if (redisUrl && redisToken) {
    return new RedisWalletChallengeStore({ redisUrl, redisToken });
  }

  return new InMemoryWalletChallengeStore();
}

let activeStore: WalletChallengeStore | null = null;

/** Return the process-wide `WalletChallengeStore`, creating it on first use. */
export function getWalletChallengeStore(): WalletChallengeStore {
  if (!activeStore) {
    activeStore = createWalletChallengeStore();
  }
  return activeStore;
}

/** Replace the active store (for tests). Pass `null` to reset to lazy default. */
export function setWalletChallengeStoreForTesting(
  store: WalletChallengeStore | null,
): void {
  activeStore = store;
}
