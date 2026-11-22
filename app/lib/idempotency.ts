import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { logger } from "@/app/lib/logger";
import { IDEMPOTENCY_TTL_MS } from "@/app/lib/db";
import { db } from "@/app/lib/db";
import { RedisIdempotencyStore } from "@/app/lib/idempotency-store-redis";

export interface IdempotencyRecord {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAt: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
  /**
   * Atomically claims `key` for the calling request.
   *
   * Returns `true` when this caller won the claim, `false` when another request
   * already holds it. Stores that cannot claim atomically omit this method;
   * `withIdempotency` then keeps the legacy read-then-run behaviour.
   */
  reserve?(key: string, ttlMs: number): Promise<boolean>;
  /** Releases a claim taken by {@link reserve} without storing a record. */
  release?(key: string): Promise<void>;
}

/**
 * Binding applied to every idempotency record.
 *
 * `resourceId` is folded into the storage key, so an `Idempotency-Key` that is
 * reused against a different resource can never resolve to (and replay) another
 * resource's cached response. `actorId` is folded into the request fingerprint,
 * so a replay attempted by a different caller is reported as a conflict instead
 * of leaking the original caller's response.
 */
export interface IdempotencyScope {
  /** Resource the record belongs to, e.g. the stream id. */
  resourceId: string;
  /** Authenticated caller the record belongs to, e.g. the wallet address. */
  actorId?: string;
}

/**
 * Builds an unambiguous, resource-scoped storage key.
 *
 * The resource id is length-prefixed so that no combination of resource id and
 * client key can collide with a different pair.
 */
export function scopedIdempotencyKey(resourceId: string, key: string): string {
  return `${resourceId.length}:${resourceId}:${key}`;
}

// Helper to create a namespaced store backed by the existing persistence layer
export function createNamespacedStore(namespace: string): IdempotencyStore {
  const backing = db.idempotency as any;
  const prefix = `idempotency:${namespace}:`;

  return {
    async get(key: string) {
      try {
        const raw = backing.get(prefix + key);
        if (raw === undefined) return null;
        const entry = raw as any;
        if (typeof entry?.fingerprint !== "string" || typeof entry?.expiresAt !== "number") {
          backing.delete(prefix + key);
          return null;
        }
        if (entry.expiresAt < Date.now()) {
          backing.delete(prefix + key);
          return null;
        }
        return {
          fingerprint: entry.fingerprint,
          statusCode: entry.status,
          body: entry.body,
          createdAt: entry.expiresAt - IDEMPOTENCY_TTL_MS,
        } as IdempotencyRecord;
      } catch (err: any) {
        throw err;
      }
    },
    async set(key: string, record: IdempotencyRecord) {
      // Persist in the backing store with an expiresAt so memory/postgres adapters
      // can perform lazy eviction. For stores that support TTL at storage layer,
      // this file can be extended to use native EX/TTL commands.
      const now = Date.now();
      const entry = {
        fingerprint: record.fingerprint,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        status: record.statusCode,
        body: record.body,
      };
      backing.set(prefix + key, entry);
    },
  };
}

/**
 * Reservation lifetime for the atomic claim taken before running a handler.
 * Kept short: it only has to cover handler execution, and a crashed instance
 * must not block retries for the full idempotency TTL.
 */
const IDEMPOTENCY_RESERVATION_TTL_MS = 30_000;

function resolveRedisConfig(): { redisUrl: string; redisToken: string } | null {
  const redisUrl =
    process.env.IDEMPOTENCY_REDIS_URL || process.env.RATE_LIMIT_REDIS_URL;
  const redisToken =
    process.env.IDEMPOTENCY_REDIS_TOKEN || process.env.RATE_LIMIT_REDIS_TOKEN;
  if (!redisUrl || !redisToken) return null;
  return { redisUrl, redisToken };
}

/**
 * Builds the store for a route namespace.
 *
 * Redis is used when its REST credentials are configured (either the
 * `IDEMPOTENCY_REDIS_*` pair or the shared `RATE_LIMIT_REDIS_*` pair), so
 * retries that land on another instance are deduplicated. Otherwise the
 * process-local store keeps the previous behaviour.
 */
export function createIdempotencyStore(namespace: string): IdempotencyStore {
  const config = resolveRedisConfig();
  if (!config) return createNamespacedStore(namespace);

  return new RedisIdempotencyStore({ ...config, namespace });
}

// Default route-scoped stores exported for callers to import.
export const settleStore = createNamespacedStore("settle");
export const withdrawStore = createNamespacedStore("withdraw");
export const orgCreateStore = createNamespacedStore("orgs.create");
export const settleStore = createIdempotencyStore("settle");
export const withdrawStore = createIdempotencyStore("withdraw");

// Validate idempotency key: printable ASCII, 1-255 characters.
// We disallow control characters and Unicode; spaces are not allowed to avoid
// ambiguity in transport and trimming behaviour.
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,255}$/;

function makeHash(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Runs a mutating request under an idempotency key.
 *
 * The record is bound to `scope.resourceId` (the stream being mutated) and,
 * when present, `scope.actorId` (the authenticated caller):
 *
 * - the storage key carries the resource id, so the same client key used on a
 *   different stream never replays that stream's cached response;
 * - the request fingerprint carries the resource id and the caller, so a
 *   replay by a different caller is answered with `409 IdempotencyKeyReused`
 *   instead of the original response.
 */
export async function withIdempotency(
  request: Request,
  routeId: string,
  store: IdempotencyStore,
  handler: () => Promise<NextResponse>,
  scope: IdempotencyScope
): Promise<NextResponse> {
  const key = request.headers?.get?.("Idempotency-Key");

  if (!key) {
    return NextResponse.json({ error: "IdempotencyKeyRequired", message: "Idempotency-Key header is required for mutating operations" }, { status: 400 });
  }

  if (typeof key !== "string" || !IDEMPOTENCY_KEY_RE.test(key)) {
    return NextResponse.json({ error: "IdempotencyKeyInvalid", message: "Idempotency-Key is invalid" }, { status: 400 });
  }

  // Read and normalise the request body. Hash body separately to avoid creating
  // a fingerprint that leaks or scales poorly for large payloads.
  // The body is hashed first so the outer fingerprint becomes:
  //   SHA-256(idempotency_key + NUL + routeId + NUL + resource_id + NUL +
  //            actor_id + NUL + SHA-256(body_json))
  let bodyJson: unknown = null;
  try {
    const text = await request.text();
    bodyJson = text ? JSON.parse(text) : null;
  } catch {
    bodyJson = null;
  }

  const bodyHash = makeHash(JSON.stringify(bodyJson ?? null));

  // Bind the record to the resource and the caller. The storage key carries
  // the resource id, so a key reused against another stream never resolves to
  // this record; the fingerprint carries the resource and the caller, so a
  // replay by a different caller is a conflict rather than a replay.
  const resourceId = (scope.resourceId ?? "").trim();
  const actorId = (scope.actorId ?? "").trim();
  const storeKey = scopedIdempotencyKey(resourceId, key);
  const fingerprint = makeHash(
    [key, routeId, resourceId, actorId, bodyHash].join("\u0000"),
  );

  // Try reading existing record. If the backing store fails, we log and
  // allow the request through — degraded replay protection is preferable to
  // blocking mutating operations.
  let existing: IdempotencyRecord | null = null;
  try {
    existing = await store.get(storeKey);
  } catch (err) {
    logger.error("Idempotency store read failed; proceeding without replay protection", { err: errMessage(err) });
    existing = null;
  }

  if (existing) {
    return replayResponse(existing, fingerprint, key);
  }

  // Claim the key before running the handler so two concurrent first requests
  // cannot both execute it. Stores without `reserve` keep the legacy behaviour.
  let reserved = false;
  if (typeof store.reserve === "function") {
    let reservationFailed = false;
    try {
      reserved = await store.reserve(storeKey, IDEMPOTENCY_RESERVATION_TTL_MS);
    } catch (err) {
      logger.error("Idempotency store reserve failed; proceeding without reservation", { err: errMessage(err) });
      reservationFailed = true;
    }

    if (!reserved && !reservationFailed) {
      // The winner may have completed between our read and the claim, so give
      // it one more chance to replay before reporting the conflict.
      let raced: IdempotencyRecord | null = null;
      try {
        raced = await store.get(storeKey);
      } catch (err) {
        logger.error("Idempotency store read failed after lost reservation", { err: errMessage(err) });
      }
      if (raced) {
        return replayResponse(raced, fingerprint, key);
      }
      return NextResponse.json(
        {
          error: "IdempotencyKeyInProgress",
          message: "An identical request is already being processed. Retry shortly.",
        },
        { status: 409, headers: { "Retry-After": "1" } },
      );
    }
  }

  // No existing record — run handler and then persist the response for future replays.
  let response: NextResponse;
  try {
    response = await handler();
  } catch (err) {
    await releaseReservation(store, storeKey, reserved);
    throw err;
  }

  // Capture response body safely
  let respBody: unknown = null;
  try {
    const clone = response.clone();
    const text = await clone.text();
    if (text) {
      try { respBody = JSON.parse(text); } catch { respBody = text; }
    } else {
      respBody = null;
    }
  } catch {
    respBody = null;
  }

  try {
    await store.set(storeKey, { fingerprint, statusCode: response.status, body: respBody, createdAt: Date.now() });
  } catch (err) {
    logger.error("Idempotency store write failed; response not persisted", { err: errMessage(err) });
    // Drop the claim so the next retry is not blocked by a marker that will
    // never be replaced with a record.
    await releaseReservation(store, storeKey, reserved);
  }

  // Tag response as non-replay
  response.headers.set("Idempotency-Replay", "false");
  return response;
}

function replayResponse(
  record: IdempotencyRecord,
  fingerprint: string,
  key: string,
): NextResponse {
  if (record.fingerprint !== fingerprint) {
    return NextResponse.json({ error: "IdempotencyKeyReused", message: "This Idempotency-Key was used with a different request body." }, { status: 409 });
  }

  const headers = new Headers({ "Idempotency-Replay": "true", "Idempotency-Key": key, "Content-Type": "application/json" });
  return new NextResponse(JSON.stringify(record.body), { status: record.statusCode, headers });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function releaseReservation(
  store: IdempotencyStore,
  storeKey: string,
  reserved: boolean,
): Promise<void> {
  if (!reserved || typeof store.release !== "function") return;
  try {
    await store.release(storeKey);
  } catch (err) {
    logger.error("Idempotency store release failed", { err: errMessage(err) });
  }
}
