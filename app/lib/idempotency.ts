import { createHash } from "crypto";
import { NextResponse } from "next/server";
import { logger, getCorrelationContext } from "@/app/lib/logger";
import { IDEMPOTENCY_TTL_MS, IDEMPOTENCY_INFLIGHT_TTL_MS } from "@/app/lib/db";
import { db } from "@/app/lib/db";

export type StoredIdempotencyRecord =
  | {
      state: "in_flight";
      fingerprint: string;
      reservedAt: number;
      expiresAt: number;
    }
  | {
      state: "committed";
      fingerprint: string;
      statusCode: number;
      body: unknown;
      createdAt: number;
      expiresAt: number;
    };

export interface IdempotencyRecord {
  state?: "in_flight" | "committed";
  fingerprint: string;
  statusCode: number;
  body: unknown;
  createdAt: number;
  reservedAt?: number;
}

export interface IdempotencyStore {
  get(key: string): Promise<StoredIdempotencyRecord | IdempotencyRecord | null>;
  set(key: string, record: IdempotencyRecord | StoredIdempotencyRecord): Promise<void>;
  setIfAbsent(key: string, record: StoredIdempotencyRecord): Promise<boolean>;
  delete(key: string): Promise<void>;
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
      if (entry.state === "in_flight") {
        return {
          state: "in_flight",
          fingerprint: entry.fingerprint,
          reservedAt: entry.reservedAt ?? (entry.expiresAt - IDEMPOTENCY_INFLIGHT_TTL_MS),
          expiresAt: entry.expiresAt,
        } as StoredIdempotencyRecord;
      }
      return {
        state: "committed",
        fingerprint: entry.fingerprint,
        statusCode: entry.status ?? entry.statusCode,
        body: entry.body,
        createdAt: entry.createdAt ?? (entry.expiresAt - IDEMPOTENCY_TTL_MS),
        expiresAt: entry.expiresAt,
      } as StoredIdempotencyRecord;
    },
    async set(key: string, record: IdempotencyRecord | StoredIdempotencyRecord) {
      const now = Date.now();
      if ((record as any).state === "in_flight") {
        const inFlight = record as any;
        backing.set(prefix + key, {
          state: "in_flight",
          fingerprint: inFlight.fingerprint,
          reservedAt: inFlight.reservedAt ?? now,
          expiresAt: now + IDEMPOTENCY_INFLIGHT_TTL_MS,
        });
        return;
      }
      const entry = {
        state: "committed",
        fingerprint: record.fingerprint,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
        status: (record as any).statusCode,
        body: record.body,
        createdAt: (record as any).createdAt ?? now,
      };
      backing.set(prefix + key, entry);
    },
    async setIfAbsent(key: string, record: StoredIdempotencyRecord): Promise<boolean> {
      return backing.insert(prefix + key, record);
    },
    async delete(key: string): Promise<void> {
      backing.delete(prefix + key);
    },
  };
}

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

function isDeterministic4xx(status: number): boolean {
  return status === 400 || status === 404 || status === 409 || status === 422;
}

function shouldCommitStatus(status: number): boolean {
  // Commit 2xx and deterministic 4xx (400, 404, 409, 422).
  // 5xx, 429, and other transient errors are released.
  if (status >= 200 && status < 300) return true;
  return isDeterministic4xx(status);
}

/**
 * Runs a mutating request under an idempotency key.
 *
 * Implements atomic reservation, commit on 2xx/deterministic 4xx, release on
 * 5xx/429/throw, stale reservation takeover, and fail-closed store availability.
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

  let bodyJson: unknown = null;
  try {
    const text = await request.text();
    bodyJson = text ? JSON.parse(text) : null;
  } catch {
    bodyJson = null;
  }

  const bodyHash = makeHash(JSON.stringify(bodyJson ?? null));
  const resourceId = (scope.resourceId ?? "").trim();
  const actorId = (scope.actorId ?? "").trim();
  const storeKey = scopedIdempotencyKey(resourceId, key);
  const fingerprint = makeHash(
    [key, routeId, resourceId, actorId, bodyHash].join("\u0000"),
  );

  const correlationContext = getCorrelationContext();
  const correlationId = correlationContext?.correlation_id;
  const requestId = correlationContext?.request_id;

  // Reserve protocol with fail-closed semantics:
  // If reading or reserving fails with store error, fail closed with 503 IDEMPOTENCY_STORE_UNAVAILABLE.
  let reservationAcquired = false;

  while (!reservationAcquired) {
    let existing: StoredIdempotencyRecord | IdempotencyRecord | null = null;
    try {
      existing = await store.get(storeKey);
    } catch (err: any) {
      logger.error("Idempotency store get failed; failing closed", {
        correlation_id: correlationId,
        routeId,
        resourceId,
        err: err?.message,
      });
      return NextResponse.json(
        {
          error: {
            code: "IDEMPOTENCY_STORE_UNAVAILABLE",
            message: "Idempotency store unavailable",
            request_id: requestId,
          },
        },
        { status: 503 }
      );
    }

    if (existing) {
      const state = (existing as any).state ?? "committed";

      if (state === "committed") {
        if (existing.fingerprint !== fingerprint) {
          logger.warn("Idempotency key reused with different fingerprint", {
            correlation_id: correlationId,
            routeId,
            resourceId,
          });
          return NextResponse.json(
            {
              error: "IdempotencyKeyReused",
              code: "IDEMPOTENCY_CONFLICT",
              message: "This Idempotency-Key was used with a different request body.",
              request_id: requestId,
            },
            { status: 409 }
          );
        }

        const headers = new Headers({
          "Idempotency-Replay": "true",
          "Idempotency-Key": key,
          "Content-Type": "application/json",
        });
        return new NextResponse(JSON.stringify(existing.body), {
          status: (existing as any).statusCode,
          headers,
        });
      }

      // Existing record is in_flight
      const reservedAt = (existing as any).reservedAt ?? 0;
      const isStale = Date.now() - reservedAt >= IDEMPOTENCY_INFLIGHT_TTL_MS;

      if (isStale) {
        logger.info("Taking over abandoned idempotency reservation", {
          correlation_id: correlationId,
          routeId,
          resourceId,
        });
        // Take over: delete the abandoned reservation and retry reserving
        try {
          await store.delete(storeKey);
        } catch (err: any) {
          logger.error("Failed to delete stale idempotency reservation", {
            correlation_id: correlationId,
            routeId,
            resourceId,
            err: err?.message,
          });
        }
        continue;
      }

      // In flight and not stale
      if (existing.fingerprint !== fingerprint) {
        logger.warn("Idempotency reservation conflict: key in flight with different fingerprint", {
          correlation_id: correlationId,
          routeId,
          resourceId,
        });
        return NextResponse.json(
          {
            error: "IdempotencyKeyReused",
            code: "IDEMPOTENCY_CONFLICT",
            message: "This Idempotency-Key is already reserved with a different request fingerprint.",
            request_id: requestId,
          },
          { status: 409 }
        );
      }

      logger.info("Idempotency reservation in flight match", {
        correlation_id: correlationId,
        routeId,
        resourceId,
      });
      return NextResponse.json(
        {
          error: {
            code: "IDEMPOTENCY_IN_FLIGHT",
            message: "A request with this Idempotency-Key is currently in flight.",
            request_id: requestId,
          },
        },
        {
          status: 409,
          headers: {
            "Retry-After": "1",
          },
        }
      );
    }

    // No existing record found: attempt setIfAbsent reservation
    const now = Date.now();
    const reservationRecord: StoredIdempotencyRecord = {
      state: "in_flight",
      fingerprint,
      reservedAt: now,
      expiresAt: now + IDEMPOTENCY_INFLIGHT_TTL_MS,
    };

    let inserted = false;
    try {
      inserted = await store.setIfAbsent(storeKey, reservationRecord);
    } catch (err: any) {
      logger.error("Idempotency store reservation failed; failing closed", {
        correlation_id: correlationId,
        routeId,
        resourceId,
        err: err?.message,
      });
      return NextResponse.json(
        {
          error: {
            code: "IDEMPOTENCY_STORE_UNAVAILABLE",
            message: "Idempotency store unavailable",
            request_id: requestId,
          },
        },
        { status: 503 }
      );
    }

    if (inserted) {
      reservationAcquired = true;
    } else {
      // Race: another request inserted between get and setIfAbsent, loop around to evaluate
      continue;
    }
  }

  // Reservation acquired. Execute handler.
  let response: NextResponse;
  try {
    response = await handler();
  } catch (err) {
    // Handler threw: release reservation so retry can re-execute
    try {
      await store.delete(storeKey);
    } catch (delErr: any) {
      logger.error("Failed to release idempotency reservation after handler throw", {
        correlation_id: correlationId,
        routeId,
        resourceId,
        err: delErr?.message,
      });
    }
    throw err;
  }

  // Response returned: check whether to commit or release
  if (shouldCommitStatus(response.status)) {
    let respBody: unknown = null;
    try {
      const clone = response.clone();
      const text = await clone.text();
      if (text) {
        try {
          respBody = JSON.parse(text);
        } catch {
          respBody = text;
        }
      } else {
        respBody = null;
      }
    } catch {
      respBody = null;
    }

    try {
      const now = Date.now();
      await store.set(storeKey, {
        state: "committed",
        fingerprint,
        statusCode: response.status,
        body: respBody,
        createdAt: now,
      });
    } catch (err: any) {
      logger.error("Idempotency store commit failed; response not persisted", {
        correlation_id: correlationId,
        routeId,
        resourceId,
        err: err?.message,
      });
    }
  } else {
    // 5xx, 429, or other non-commit status: release reservation so retry can re-execute
    try {
      await store.delete(storeKey);
    } catch (err: any) {
      logger.error("Failed to release idempotency reservation for transient status", {
        correlation_id: correlationId,
        routeId,
        resourceId,
        status: response.status,
        err: err?.message,
      });
    }
  }

  // Tag response as non-replay
  response.headers.set("Idempotency-Replay", "false");
  return response;
}
