/**
 * @module outbox
 *
 * Transactional outbox for reliable webhook delivery.
 *
 * ## Problem solved
 * Without an outbox, webhook emission is a fire-and-forget call made _after_
 * the business state mutation is committed.  If the process crashes (or the
 * network blips) between "write state" and "send webhook", the event is
 * silently lost — there is no record that a delivery was ever attempted.
 *
 * ## How the outbox fixes this
 * The outbox decouples the two phases:
 *
 *   1. **Write** — `appendToOutbox(entry)` records the webhook event in the
 *      outbox store in the same logical transaction as the business mutation.
 *      The entry starts with status `"pending"` and is never lost.
 *
 *   2. **Drain** — `OutboxDrainWorker.drain()` (called on a periodic schedule
 *      or on-demand) reads every `"pending"` entry and hands it off to the
 *      `WebhookDeliveryWorker`.  On success the entry is marked `"dispatched"`;
 *      on error it stays `"pending"` and will be retried on the next drain.
 *
 * ## Delivery guarantees
 * - **At-least-once**: an entry may be dispatched more than once if the drain
 *   worker crashes after dispatch but before the status update.  The
 *   `WebhookDeliveryWorker` already issues idempotent `X-StreamPay-Delivery-Id`
 *   headers, so duplicate dispatches are safe.
 * - **No event loss**: `"pending"` entries survive process restarts (or, when
 *   backed by a durable store, survive full node failures).
 *
 * ## In-memory vs durable
 * `OutboxStore` is an in-process Map for now, matching the rest of the
 * in-memory adapter pattern used throughout this codebase.  Swap in a
 * PostgreSQL-backed implementation (inserting into an `outbox` table inside
 * the same transaction that writes the business row) to achieve true
 * durability.
 *
 * @see {@link OutboxEntry}
 * @see {@link OutboxDrainWorker}
 */

import crypto from "crypto";
import { logger } from "../app/lib/logger";
import {
  WebhookDeliveryWorker,
  webhookDeliveryWorker,
} from "../app/lib/webhook-delivery-worker";
import type { WebhookEndpoint, WebhookEvent } from "../app/lib/webhook-delivery";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Lifecycle status of an outbox entry. */
export type OutboxEntryStatus =
  | "pending"     // recorded, not yet dispatched to the delivery worker
  | "dispatched"  // handed off to the delivery worker (at-least-once guarantee)
  | "failed";     // drain attempt threw an unexpected error; will be retried

/**
 * A single row in the outbox table / in-memory store.
 *
 * The entry is created atomically alongside the business mutation and is only
 * ever removed by explicit archival (not by the drain worker — that would risk
 * losing the audit trail).
 */
export interface OutboxEntry {
  /** Stable unique identifier for this outbox row. */
  readonly id: string;

  /** The webhook endpoint that should receive this event. */
  readonly endpoint: WebhookEndpoint;

  /** The event payload to deliver. */
  readonly event: WebhookEvent;

  /**
   * Stable delivery ID forwarded to `WebhookDeliveryWorker.processDelivery`.
   * Keeping it inside the outbox entry makes re-drain idempotent: if the
   * drain worker calls `processDelivery` twice with the same `deliveryId` the
   * second call just finds the record already `"delivered"` or `"dlq"`.
   */
  readonly deliveryId: string;

  /** Current processing status. */
  status: OutboxEntryStatus;

  /** ISO-8601 timestamp when the entry was created. */
  readonly createdAt: string;

  /** ISO-8601 timestamp of the last status change. */
  updatedAt: string;

  /** ISO-8601 timestamp when dispatch was attempted (may be undefined). */
  dispatchedAt?: string;

  /** Human-readable description of the last error (when status is "failed"). */
  lastError?: string;

  /**
   * Number of drain attempts made against this entry.
   * Useful for detecting stuck entries in operational dashboards.
   */
  drainAttempts: number;
}

// ── OutboxStore ───────────────────────────────────────────────────────────────

/**
 * Minimal key/value contract for the outbox backing store.
 *
 * The in-memory implementation satisfies this interface.
 * A durable PostgreSQL implementation would wrap a transaction that inserts
 * the outbox row alongside the business-logic INSERT/UPDATE.
 */
export interface OutboxStore {
  /** Persist a new outbox entry. Throws if `id` already exists. */
  append(entry: OutboxEntry): void;

  /** Return all entries with status `"pending"` (or `"failed"` if included). */
  listPending(): OutboxEntry[];

  /** Overwrite an existing entry (for status transitions). */
  update(entry: OutboxEntry): void;

  /** Return entry by id, or undefined if absent. */
  get(id: string): OutboxEntry | undefined;

  /** Return all entries (for tests and observability endpoints). */
  list(): OutboxEntry[];

  /** Remove all entries. Intended only for test teardown. */
  clear(): void;
}

/**
 * Default in-process outbox store backed by a plain `Map`.
 *
 * Thread-safety: JavaScript is single-threaded, so no locking is needed
 * for Map operations.
 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>();

  append(entry: OutboxEntry): void {
    if (this.entries.has(entry.id)) {
      throw new Error(`OutboxStore: entry with id "${entry.id}" already exists`);
    }
    this.entries.set(entry.id, { ...entry });
  }

  listPending(): OutboxEntry[] {
    const result: OutboxEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.status === "pending" || entry.status === "failed") {
        result.push({ ...entry });
      }
    }
    // Oldest-first — process in creation order to preserve causality.
    return result.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  update(entry: OutboxEntry): void {
    if (!this.entries.has(entry.id)) {
      throw new Error(`OutboxStore: entry with id "${entry.id}" not found`);
    }
    this.entries.set(entry.id, { ...entry });
  }

  get(id: string): OutboxEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry } : undefined;
  }

  list(): OutboxEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  clear(): void {
    this.entries.clear();
  }
}

// ── Default singleton store ───────────────────────────────────────────────────

/** Module-level singleton — replace via `setOutboxStore()` in tests. */
let _store: OutboxStore = new InMemoryOutboxStore();

/** Read the active outbox store. */
export function getOutboxStore(): OutboxStore {
  return _store;
}

/**
 * Swap the active outbox store.
 *
 * Call this during test setup or when mounting a durable PostgreSQL adapter.
 *
 * ```ts
 * const fresh = new InMemoryOutboxStore();
 * setOutboxStore(fresh);
 * ```
 */
export function setOutboxStore(store: OutboxStore): void {
  _store = store;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a webhook event in the outbox.
 *
 * Call this **inside the same logical transaction** as your business mutation
 * so that the outbox row and the state change are committed atomically.
 *
 * The function is synchronous because the in-memory store is synchronous.
 * In a durable implementation this would become `async` and participate in
 * the surrounding database transaction.
 *
 * @example
 * ```ts
 * // Inside a stream lifecycle mutation:
 * stream.status = "active";
 * db.streams.set(stream.id, stream);
 * appendToOutbox({ endpoint, event });   // recorded in same "transaction"
 * ```
 *
 * @param params.endpoint  The webhook endpoint to deliver to.
 * @param params.event     The event payload.
 * @param params.store     Optional explicit store (defaults to module singleton).
 * @returns The newly created {@link OutboxEntry}.
 */
export function appendToOutbox(params: {
  endpoint: WebhookEndpoint;
  event: WebhookEvent;
  store?: OutboxStore;
}): OutboxEntry {
  const { endpoint, event, store = _store } = params;

  const now = new Date().toISOString();
  const entry: OutboxEntry = {
    id: crypto.randomUUID(),
    endpoint,
    event,
    deliveryId: crypto.randomUUID(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    drainAttempts: 0,
  };

  store.append(entry);

  logger.info("Outbox: entry recorded", {
    outbox_id: entry.id,
    delivery_id: entry.deliveryId,
    endpoint_id: endpoint.id,
    event_id: event.id,
    event_type: event.eventType,
    stream_id: event.streamId,
  });

  return entry;
}

// ── Drain worker ──────────────────────────────────────────────────────────────

/**
 * Options accepted by {@link OutboxDrainWorker}.
 */
export interface OutboxDrainWorkerOptions {
  /**
   * Maximum number of entries to process in a single `drain()` call.
   * Defaults to 100.  Set lower in tests or when the queue is very large.
   */
  batchSize?: number;

  /**
   * Override the delivery worker used to dispatch entries.
   * Defaults to the module-level `webhookDeliveryWorker` singleton.
   */
  deliveryWorker?: WebhookDeliveryWorker;

  /**
   * Override the outbox store.
   * Defaults to the module-level `_store` singleton.
   */
  store?: OutboxStore;
}

/**
 * Drain result returned by {@link OutboxDrainWorker.drain}.
 */
export interface DrainResult {
  /** Number of entries that were successfully dispatched to the delivery worker. */
  dispatched: number;
  /** Number of entries that produced an error during this drain cycle. */
  failed: number;
  /** Total pending entries visible at the start of this drain cycle. */
  total: number;
}

/**
 * Outbox drain worker.
 *
 * Call `drain()` on a periodic schedule (e.g. every 5 s) or immediately after
 * writing to the outbox from a business mutation.
 *
 * ```ts
 * const drainer = new OutboxDrainWorker();
 *
 * // Schedule periodic drain
 * setInterval(() => drainer.drain(), 5_000);
 *
 * // Or drain immediately after writing a business event
 * appendToOutbox({ endpoint, event });
 * await drainer.drain();
 * ```
 */
export class OutboxDrainWorker {
  private readonly batchSize: number;
  private readonly worker: WebhookDeliveryWorker;
  private readonly store: OutboxStore;

  constructor(options: OutboxDrainWorkerOptions = {}) {
    this.batchSize = options.batchSize ?? 100;
    this.worker = options.deliveryWorker ?? webhookDeliveryWorker;
    this.store = options.store ?? _store;
  }

  /**
   * Process all pending outbox entries up to `batchSize`.
   *
   * Each entry is dispatched to `WebhookDeliveryWorker.processDelivery`.
   * The delivery worker manages its own retry/DLQ lifecycle; the outbox only
   * tracks whether the handoff succeeded.
   *
   * - On successful handoff → entry status becomes `"dispatched"`.
   * - On unexpected error  → entry status becomes `"failed"` and will be
   *   retried on the next `drain()` call.
   *
   * `drain()` never throws — individual entry errors are caught and logged.
   *
   * @returns A {@link DrainResult} summary.
   */
  async drain(): Promise<DrainResult> {
    const pending = this.store.listPending().slice(0, this.batchSize);
    const total = pending.length;
    let dispatched = 0;
    let failed = 0;

    if (total === 0) {
      return { dispatched: 0, failed: 0, total: 0 };
    }

    logger.info("Outbox: drain starting", {
      batch_size: this.batchSize,
      pending_count: total,
    });

    for (const entry of pending) {
      const freshEntry: OutboxEntry = {
        ...entry,
        drainAttempts: entry.drainAttempts + 1,
        updatedAt: new Date().toISOString(),
      };

      try {
        // Fire-and-forget: processDelivery manages retries internally.
        // We mark the entry as "dispatched" once the handoff is confirmed;
        // from this point the delivery worker owns the retry lifecycle.
        const result = await this.worker.processDelivery(
          freshEntry.endpoint,
          freshEntry.event,
          freshEntry.deliveryId,
        );

        const now = new Date().toISOString();
        const updated: OutboxEntry = {
          ...freshEntry,
          status: "dispatched",
          dispatchedAt: now,
          updatedAt: now,
        };
        this.store.update(updated);
        dispatched++;

        logger.info("Outbox: entry dispatched", {
          outbox_id: entry.id,
          delivery_id: entry.deliveryId,
          endpoint_id: entry.endpoint.id,
          event_id: entry.event.id,
          event_type: entry.event.eventType,
          delivery_success: result.success,
          delivery_attempts: result.attempts,
          dlqed: result.dlqed ?? false,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const updated: OutboxEntry = {
          ...freshEntry,
          status: "failed",
          lastError: errorMsg,
          updatedAt: new Date().toISOString(),
        };
        this.store.update(updated);
        failed++;

        logger.error("Outbox: entry dispatch failed", {
          outbox_id: entry.id,
          delivery_id: entry.deliveryId,
          endpoint_id: entry.endpoint.id,
          event_id: entry.event.id,
          error: errorMsg,
          drain_attempts: freshEntry.drainAttempts,
        });
      }
    }

    logger.info("Outbox: drain complete", {
      total,
      dispatched,
      failed,
    });

    return { dispatched, failed, total };
  }

  /**
   * Return a snapshot of all outbox entries (for observability).
   */
  snapshot(): OutboxEntry[] {
    return this.store.list();
  }

  /**
   * Return counts broken down by status (for health checks / metrics).
   */
  stats(): { pending: number; dispatched: number; failed: number; total: number } {
    const entries = this.store.list();
    const pending = entries.filter((e) => e.status === "pending").length;
    const dispatched = entries.filter((e) => e.status === "dispatched").length;
    const failed = entries.filter((e) => e.status === "failed").length;
    return { pending, dispatched, failed, total: entries.length };
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

/**
 * Default drain worker instance.
 *
 * In production, schedule this to run periodically:
 *
 * ```ts
 * import { outboxDrainWorker } from "@/lib/outbox";
 * setInterval(() => outboxDrainWorker.drain(), 5_000);
 * ```
 */
export const outboxDrainWorker = new OutboxDrainWorker();
