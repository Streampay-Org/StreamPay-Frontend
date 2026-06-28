import crypto from "crypto";
import { getCorrelationContext, logger } from "./logger";

/**
 * Transactional outbox for stream domain events.
 *
 * `event-bus.ts` historically published events *inline* (a fire-and-forget
 * `EventEmitter.emit`). If the process crashes after a state change is
 * committed but before — or during — the emit, that event is silently lost
 * and downstream consumers (SSE subscribers, webhooks, analytics) never learn
 * about it.
 *
 * The outbox closes that gap. Producers append an event to this table in the
 * *same step* as the state mutation (in this in-memory mock both are
 * synchronous Map writes, so they are effectively one transaction). A separate
 * worker then drains the table FIFO and performs the actual publish. Because
 * an entry is only removed from the "claimable" set once it is explicitly
 * marked `published`, delivery is **at-least-once**: a crash at any point
 * leaves the entry to be re-claimed and re-published. Downstream consumers must
 * therefore be idempotent (dedupe on `entry.id`).
 *
 * This mirrors the production design — a Postgres `outbox` table drained by a
 * background worker — while remaining dependency-free for the mock backend.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Domain event types that flow through the outbox. */
export type StreamEventType = "stream.updated" | "settle.finished";

/**
 * Lifecycle of an outbox entry.
 * - `pending`    — written, waiting to be claimed/redelivered.
 * - `processing` — claimed by a worker; publish in flight.
 * - `published`  — successfully emitted; terminal success.
 * - `failed`     — a publish attempt failed but retries remain.
 * - `dead`       — exhausted all attempts; parked in the DLQ for inspection.
 */
export type OutboxStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "dead";

export interface StreamEventOutboxEntry {
  /** Unique, stable id used by consumers for idempotent dedupe. */
  readonly id: string;
  /** Monotonic sequence number used for FIFO ordering. */
  readonly seq: number;
  /** Domain event type. */
  readonly eventType: StreamEventType;
  /** Stream the event belongs to. */
  readonly streamId: string;
  /** Serialisable event payload. */
  readonly payload: unknown;
  /** Current lifecycle status. */
  status: OutboxStatus;
  /** Number of publish attempts made so far. */
  attempts: number;
  /** Attempts after which the entry is moved to the DLQ (`dead`). */
  readonly maxAttempts: number;
  /** ISO timestamp the entry was created. */
  readonly createdAt: string;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
  /** ISO timestamp before which the entry must not be (re)claimed. */
  nextAttemptAt: string;
  /** ISO timestamp the entry was last claimed (drives crash recovery). */
  lockedAt?: string;
  /** Correlation id captured at enqueue time, restored during draining. */
  correlationId?: string;
  /** Last failure message, for observability. */
  lastError?: string;
}

export interface EnqueueInput {
  eventType: StreamEventType;
  streamId: string;
  payload: unknown;
  /**
   * Caller-supplied id. Providing a deterministic id (e.g. derived from the
   * state version) makes the *enqueue itself* idempotent, so a retried producer
   * does not create duplicate outbox rows.
   */
  id?: string;
  /** Override the default retry budget for this entry. */
  maxAttempts?: number;
}

// ── Tunables ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * How long a claimed (`processing`) entry may stay locked before it is
 * considered abandoned (worker crashed) and becomes eligible for re-claiming.
 * This is what guarantees no event is lost when a worker dies mid-publish.
 */
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** Exponential backoff with a hard ceiling. */
function backoffMs(attempts: number): number {
  const delay = BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

// ── Store ───────────────────────────────────────────────────────────────────

export class StreamEventOutbox {
  private readonly entries = new Map<string, StreamEventOutboxEntry>();
  private seqCounter = 0;
  private readonly visibilityTimeoutMs: number;

  constructor(opts: { visibilityTimeoutMs?: number } = {}) {
    this.visibilityTimeoutMs =
      opts.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
  }

  /**
   * Append an event to the outbox. Intended to run in the same transaction as
   * the state change that produced it. Returns the existing entry unchanged if
   * `id` was supplied and already present (idempotent enqueue).
   */
  enqueue(input: EnqueueInput): StreamEventOutboxEntry {
    const id = input.id ?? `evt-${crypto.randomUUID()}`;

    const existing = this.entries.get(id);
    if (existing) {
      logger.info("Stream event already in outbox; enqueue is idempotent", {
        outbox_id: id,
        event_type: existing.eventType,
        stream_id: existing.streamId,
      });
      return existing;
    }

    const now = new Date().toISOString();
    const correlationId = getCorrelationContext()?.correlation_id;

    const entry: StreamEventOutboxEntry = {
      id,
      seq: ++this.seqCounter,
      eventType: input.eventType,
      streamId: input.streamId,
      payload: input.payload,
      status: "pending",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      correlationId,
    };

    this.entries.set(id, entry);

    logger.info("Stream event written to outbox", {
      outbox_id: id,
      seq: entry.seq,
      event_type: entry.eventType,
      stream_id: entry.streamId,
      correlation_id: correlationId,
    });

    return entry;
  }

  /** Whether an entry is eligible to be (re)claimed right now. */
  private isClaimable(entry: StreamEventOutboxEntry, nowMs: number): boolean {
    if (entry.status === "published" || entry.status === "dead") return false;

    // A `processing` entry whose lock has not expired is owned by a live
    // worker; leave it alone. Once the visibility timeout passes we assume the
    // worker died and reclaim it (this is the crash-recovery path).
    if (entry.status === "processing") {
      const lockedMs = entry.lockedAt ? Date.parse(entry.lockedAt) : 0;
      return nowMs - lockedMs >= this.visibilityTimeoutMs;
    }

    // `pending` / `failed` honour the backoff gate.
    return Date.parse(entry.nextAttemptAt) <= nowMs;
  }

  /**
   * Claim up to `limit` entries in FIFO (sequence) order, marking each
   * `processing`. The claimed entries are owned by the caller until they are
   * marked published/failed or their visibility timeout lapses.
   */
  claimBatch(limit = 50): StreamEventOutboxEntry[] {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const claimable = Array.from(this.entries.values())
      .filter((entry) => this.isClaimable(entry, nowMs))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.max(0, limit));

    for (const entry of claimable) {
      entry.status = "processing";
      entry.lockedAt = now;
      entry.updatedAt = now;
    }

    return claimable;
  }

  /** Convenience wrapper around {@link claimBatch} for single-entry draining. */
  claimNext(): StreamEventOutboxEntry | undefined {
    return this.claimBatch(1)[0];
  }

  /** Mark an entry as successfully published (terminal success). */
  markPublished(id: string): StreamEventOutboxEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    entry.status = "published";
    entry.attempts += 1;
    entry.updatedAt = new Date().toISOString();
    entry.lockedAt = undefined;
    entry.lastError = undefined;

    logger.info("Stream event published from outbox", {
      outbox_id: id,
      seq: entry.seq,
      event_type: entry.eventType,
      stream_id: entry.streamId,
      attempts: entry.attempts,
    });

    return entry;
  }

  /**
   * Record a failed publish. Schedules a backoff retry while attempts remain,
   * otherwise moves the entry to the dead-letter queue (`dead`).
   */
  markFailed(id: string, error: string): StreamEventOutboxEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    entry.attempts += 1;
    entry.lastError = error;
    entry.lockedAt = undefined;
    const now = Date.now();
    entry.updatedAt = new Date(now).toISOString();

    if (entry.attempts >= entry.maxAttempts) {
      entry.status = "dead";
      logger.error("Stream event moved to outbox DLQ", {
        outbox_id: id,
        seq: entry.seq,
        event_type: entry.eventType,
        stream_id: entry.streamId,
        attempts: entry.attempts,
        error,
      });
    } else {
      entry.status = "failed";
      entry.nextAttemptAt = new Date(now + backoffMs(entry.attempts)).toISOString();
      logger.warn("Stream event publish failed; will retry", {
        outbox_id: id,
        seq: entry.seq,
        attempts: entry.attempts,
        next_attempt_at: entry.nextAttemptAt,
        error,
      });
    }

    return entry;
  }

  /** Fetch a single entry by id. */
  get(id: string): StreamEventOutboxEntry | undefined {
    return this.entries.get(id);
  }

  /** All entries, ordered FIFO by sequence. */
  getAll(): StreamEventOutboxEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.seq - b.seq);
  }

  /** Entries currently parked in the dead-letter queue. */
  getDeadLetters(): StreamEventOutboxEntry[] {
    return this.getAll().filter((entry) => entry.status === "dead");
  }

  /** Aggregate counts per status, for health/metrics endpoints. */
  getStatistics(): Record<OutboxStatus | "total", number> {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      pending: entries.filter((e) => e.status === "pending").length,
      processing: entries.filter((e) => e.status === "processing").length,
      published: entries.filter((e) => e.status === "published").length,
      failed: entries.filter((e) => e.status === "failed").length,
      dead: entries.filter((e) => e.status === "dead").length,
    };
  }

  /** Remove all entries (testing / reset). */
  clear(): void {
    this.entries.clear();
    this.seqCounter = 0;
  }
}

/** Process-wide singleton used by the event bus and the outbox worker. */
export const streamEventOutbox = new StreamEventOutbox();
