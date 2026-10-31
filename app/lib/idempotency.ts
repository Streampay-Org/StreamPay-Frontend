import { createHash, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { logger } from "@/app/lib/logger";
import { IDEMPOTENCY_TTL_MS } from "@/app/lib/db";
import { db } from "@/app/lib/db";

export interface IdempotencyRecord {
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAt: number;
  reservationId?: string;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
  setIfAbsent?(key: string, record: IdempotencyRecord): Promise<boolean>;
  commit?(key: string, reservationId: string, record: IdempotencyRecord): Promise<boolean>;
  release?(key: string, reservationId: string): Promise<void>;
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
function inflightTtl() {
  const value = Number(process.env.IDEMPOTENCY_INFLIGHT_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

export function createNamespacedStore(namespace: string): IdempotencyStore {
  const backing = db.idempotency;
  const prefix = "idempotency:" + namespace + ":";
  type Stored = IdempotencyRecord & { expiresAt: number; status: number };
  function read(key: string): Stored | null {
    const value = backing.get(prefix + key) as Stored | undefined;
    if (!value) return null;
    if (typeof value.fingerprint !== "string" || value.expiresAt <= Date.now()) {
      backing.delete(prefix + key);
      return null;
    }
    return value;
  }
  function encode(record: IdempotencyRecord): Stored {
    return { ...record, status: record.statusCode,
      expiresAt: Date.now() + (record.statusCode === 0 ? inflightTtl() : IDEMPOTENCY_TTL_MS) };
  }
  return {
    async get(key) {
      const record = read(key);
      return record ? { ...record, statusCode: record.status,
        createdAt: record.createdAt ?? record.expiresAt - IDEMPOTENCY_TTL_MS } : null;
    },
    async set(key, record) { backing.set(prefix + key, encode(record)); },
    async setIfAbsent(key, record) {
      read(key); // Expire abandoned reservations before the atomic create-only insert.
      return backing.insert(prefix + key, encode(record));
    },
    async commit(key, owner, record) {
      const current = backing.get(prefix + key) as Stored | undefined;
      if (current?.reservationId !== owner || current.status !== 0) return false;
      backing.set(prefix + key, encode(record));
      return true;
    },
    async release(key, owner) {
      const current = backing.get(prefix + key) as Stored | undefined;
      if (current?.reservationId === owner && current.status === 0) backing.delete(prefix + key);
    },
  };
}

const activeRequests = new WeakMap<IdempotencyStore, Map<string, string>>();

// Default route-scoped stores exported for callers to import.
export const settleStore = createNamespacedStore("settle");
export const withdrawStore = createNamespacedStore("withdraw");

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
    const text = await request.clone().text();
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

  const unavailable = () => NextResponse.json({
    error: "IDEMPOTENCY_STORE_UNAVAILABLE", message: "Retry when replay protection is available.",
  }, { status: 503 });
  const occupied = (record: IdempotencyRecord | null) => {
    if (record && record.fingerprint !== fingerprint) {
      return NextResponse.json({
        error: "IdempotencyKeyReused", code: "IDEMPOTENCY_CONFLICT",
        message: "This Idempotency-Key was used with a different request body.",
      }, { status: 409 });
    }
    if (!record || record.statusCode === 0) {
      return NextResponse.json({
        error: "IDEMPOTENCY_IN_FLIGHT", message: "This request is still being processed.",
      }, { status: 409, headers: { "Retry-After": "1" } });
    }
    return new NextResponse(JSON.stringify(record.body), {
      status: record.statusCode,
      headers: { "Idempotency-Replay": "true", "Idempotency-Key": key, "Content-Type": "application/json" },
    });
  };
  const active = activeRequests.get(store) ?? new Map<string, string>();
  activeRequests.set(store, active);
  const running = active.get(storeKey);
  if (running) return occupied({ fingerprint: running, statusCode: 0, body: null, createdAt: Date.now() });

  const owner = randomUUID();
  try {
    const existing = await store.get(storeKey);
    if (existing) return occupied(existing);
    if (!store.setIfAbsent || !store.commit || !store.release) return unavailable();
    const reserved = await store.setIfAbsent(storeKey, {
      fingerprint, statusCode: 0, body: null, createdAt: Date.now(), reservationId: owner,
    });
    if (!reserved) return occupied(await store.get(storeKey));
  } catch {
    logger.error("Idempotency store unavailable; mutation refused");
    return unavailable();
  }

  active.set(storeKey, fingerprint);
  try {
    const response = await handler();
    const cacheable = (response.status >= 200 && response.status < 300) ||
      [400, 404, 409, 422].includes(response.status);
    if (!cacheable) {
      await store.release!(storeKey, owner);
    } else {
      const text = await response.clone().text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      const committed = await store.commit!(storeKey, owner, {
        fingerprint, statusCode: response.status, body, createdAt: Date.now(),
      });
      if (!committed) return unavailable();
    }
    response.headers.set("Idempotency-Replay", "false");
    return response;
  } catch (error) {
    try { await store.release!(storeKey, owner); } catch {
      logger.error("Idempotency reservation release failed");
    }
    throw error;
  } finally {
    active.delete(storeKey);
  }
}
