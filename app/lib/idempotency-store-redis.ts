/**
 * Redis-backed IdempotencyStore
 *
 * Uses the same Upstash REST transport as `rate-limit-store-redis.ts` so the
 * module needs no Redis client dependency and works on the Node.js runtime.
 *
 * Records are written with `SET ... PX <ttl>` so expiry is handled by Redis
 * itself. `reserve` claims a key atomically with `SET ... NX PX <ttl>`, which
 * lets `withIdempotency` stop two concurrent first requests from both running
 * the handler.
 *
 * Failure policy: transport and protocol errors are thrown to the caller.
 * `withIdempotency` logs them and continues without replay protection, which
 * mirrors the in-memory store's log-and-continue behaviour.
 */

import { IDEMPOTENCY_TTL_MS } from "@/app/lib/db";
import type { IdempotencyRecord, IdempotencyStore } from "@/app/lib/idempotency";

/** Key namespace shared across all application instances. */
export const IDEMPOTENCY_KEY_PREFIX = "streampay:idem:v1:";

/** Per-call Redis timeout in milliseconds. */
const REDIS_TIMEOUT_MS = 150;

/** Marker written by `reserve` until the real record replaces it. */
const RESERVATION_MARKER = "1";

interface UpstashResponse {
  result?: unknown;
  error?: string;
}

export interface RedisIdempotencyStoreOptions {
  /** Upstash (or compatible) REST URL, e.g. https://your-db.upstash.io */
  redisUrl: string;
  /** Upstash REST API token (Bearer). */
  redisToken: string;
  /** Route namespace, e.g. `settle` or `withdraw`. */
  namespace: string;
  /** Per-call timeout. Defaults to 150 ms. */
  timeoutMs?: number;
  /** Record TTL. Defaults to `IDEMPOTENCY_TTL_MS`. */
  ttlMs?: number;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redisUrl: string;
  private readonly redisToken: string;
  private readonly namespace: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;

  constructor(options: RedisIdempotencyStoreOptions) {
    this.redisUrl = options.redisUrl.replace(/\/$/, "");
    this.redisToken = options.redisToken;
    this.namespace = options.namespace;
    this.timeoutMs = options.timeoutMs ?? REDIS_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.command(["GET", this.storageKey(key)]);
    if (typeof raw !== "string") return null;

    try {
      const parsed = JSON.parse(raw) as Partial<IdempotencyRecord> | null;
      if (
        !parsed ||
        typeof parsed.fingerprint !== "string" ||
        typeof parsed.statusCode !== "number" ||
        typeof parsed.createdAt !== "number"
      ) {
        return null;
      }
      return {
        fingerprint: parsed.fingerprint,
        statusCode: parsed.statusCode,
        body: parsed.body ?? null,
        createdAt: parsed.createdAt,
      };
    } catch {
      return null;
    }
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    await this.command([
      "SET",
      this.storageKey(key),
      JSON.stringify(record),
      "PX",
      this.ttlMs,
    ]);
  }

  async reserve(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.command([
      "SET",
      this.storageKey(key),
      RESERVATION_MARKER,
      "NX",
      "PX",
      ttlMs,
    ]);
    return result === "OK";
  }

  async release(key: string): Promise<void> {
    await this.command(["DEL", this.storageKey(key)]);
  }

  private storageKey(key: string): string {
    return `${IDEMPOTENCY_KEY_PREFIX}${this.namespace}:${key}`;
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.redisUrl}/pipeline`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([args.map(String)]),
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

      return first?.result ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}
