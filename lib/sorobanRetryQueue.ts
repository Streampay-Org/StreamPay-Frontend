/**
 * Persistent Soroban Retry Queue
 *
 * ## Purpose
 * Soroban RPC operations (simulate, submit, fetch) can fail transiently
 * due to network issues, ledger inclusion timeouts, or RPC node
 * unavailability. This module provides a persistent retry queue that:
 *
 * - Accepts failed Soroban operations for later retry.
 * - Schedules retries with **exponential backoff + jitter**.
 * - Exhausts retries after a configurable maximum, then moves items to
 *   a **dead-letter queue** for manual intervention.
 * - Emits structured logs with correlation IDs on every state transition.
 * - Validates all inputs at the boundary and returns **standardised error
 *   envelopes**.
 *
 * ## Lifecycle
 *
 * ```
 * enqueue() ──► PENDING ──► dequeue() ──► PROCESSING
 *                  ▲                          │
 *                  │               markFailed() + backoff
 *                  │                          │
 *                  │      retries < max?      │  retries >= max?
 *                  └──────────────────────────┼──────────────► DEAD LETTER
 *                                             │
 *                                  markComplete() ──► COMPLETED (removed)
 * ```
 *
 * ## Persistence Strategy
 * Currently uses an in-memory `Map` (matching the project's existing
 * patterns for `cursorsDb`, `processedEventsDb`, etc.). The storage
 * interface is intentionally narrow so a future migration to PostgreSQL
 * or Redis requires swapping only the storage layer.
 *
 * ## Public API
 *
 * | Method                    | Description                              |
 * |---------------------------|------------------------------------------|
 * | `enqueue(op, payload)`    | Add a retryable operation to the queue.  |
 * | `dequeue()`               | Retrieve the next ready item (FIFO).     |
 * | `markComplete(id)`        | Remove a successfully retried item.      |
 * | `markFailed(id, error)`   | Record a failed attempt; schedule retry. |
 * | `getQueueDepth()`         | Number of items in PENDING state.        |
 * | `getDeadLetterEntries()`  | Items that exhausted all retries.        |
 * | `requeueDeadLetter(id)`   | Move a dead-letter item back to PENDING. |
 * | `getEntry(id)`            | Inspect a single entry.                  |
 * | `clear()`                 | Reset all state (test helper).           |
 *
 * ## Configuration
 *
 * | Option              | Default | Description                            |
 * |---------------------|---------|----------------------------------------|
 * | `maxRetries`        | 3       | Attempts before dead-letter.           |
 * | `baseDelayMs`       | 1000    | Starting backoff delay (ms).           |
 * | `maxDelayMs`        | 30000   | Cap on exponential backoff.            |
 * | `jitterFactor`      | 0.1     | ±10 % random jitter on each delay.     |
 *
 * ## Error Envelope
 * Every public method returns or throws a standardised error shape so
 * callers can pattern-match without inspecting raw strings.
 *
 * @module sorobanRetryQueue
 */

import { randomUUID } from "crypto";
import {
  SorobanError,
  SorobanErrorCode,
} from "../types";

// =============================================================================
// Types
// =============================================================================

/** All recognised Soroban operations that can be retried. */
export type SorobanOperation =
  | "createStream"
  | "cancelStream"
  | "fetchStream";

/** Payload shapes keyed by operation. */
export interface SorobanOperationPayloads {
  createStream: { streamId: string; payload: unknown };
  cancelStream: { streamId: string };
  fetchStream: { streamId: string };
}

/**
 * Standardised error envelope returned by every public method.
 *
 * Callers can always destructure `{ ok, error }` without worrying about
 * thrown exceptions for validation failures.
 */
export interface RetryQueueResult<T = void> {
  /** `true` when the operation succeeded. */
  ok: boolean;
  /** Present only when `ok === false`. */
  error?: RetryQueueError;
  /** Present only when `ok === true` and the method returns data. */
  data?: T;
}

/** Internal error representation — never includes raw secrets or PII. */
export interface RetryQueueError {
  /** Machine-readable error code (e.g. `INVALID_PAYLOAD`). */
  code: string;
  /** Human-readable description, safe for API responses. */
  message: string;
  /** Correlation ID of the failing call for traceability. */
  correlationId: string;
  /** Optional structured details for debugging. */
  details?: Record<string, unknown>;
}

/** Immutable snapshot of a single retry-queue entry. */
export interface RetryQueueEntry {
  /** Unique entry identifier. */
  id: string;
  /** Soroban operation name. */
  operation: SorobanOperation;
  /** Operation-specific payload. */
  payload: SorobanOperationPayloads[SorobanOperation];
  /** How many retry attempts have been made (0 = initial). */
  attempts: number;
  /** Maximum allowed attempts before dead-letter. */
  maxAttempts: number;
  /** Unix epoch ms when this entry is next eligible for dequeue. */
  nextRetryAt: number;
  /** The last Soroban error that occurred, if any. */
  lastError: SorobanError | null;
  /** Current lifecycle status. */
  status: RetryEntryStatus;
  /** Correlation ID for end-to-end tracing. */
  correlationId: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

export type RetryEntryStatus = "pending" | "processing" | "dead";

// =============================================================================
// Configuration
// =============================================================================

export interface SorobanRetryQueueConfig {
  /** Maximum retry attempts before an entry is moved to the dead-letter queue. */
  maxRetries: number;
  /** Base delay in milliseconds for the first retry. */
  baseDelayMs: number;
  /** Maximum delay cap for exponential backoff. */
  maxDelayMs: number;
  /**
   * Jitter factor applied to each delay. A value of `0.1` means the
   * actual delay varies by ±10 % around the computed backoff.
   */
  jitterFactor: number;
}

export const DEFAULT_RETRY_QUEUE_CONFIG: Readonly<SorobanRetryQueueConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterFactor: 0.1,
} as const;

// =============================================================================
// Validation Helpers
// =============================================================================

const VALID_OPERATIONS: ReadonlySet<string> = new Set<SorobanOperation>([
  "createStream",
  "cancelStream",
  "fetchStream",
]);

function buildError(
  code: string,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
): RetryQueueError {
  return { code, message, correlationId, details };
}

/**
 * Validate that a string is a known Soroban operation.
 */
function validateOperation(
  value: unknown,
  correlationId: string,
): RetryQueueError | null {
  if (typeof value !== "string" || !VALID_OPERATIONS.has(value)) {
    return buildError(
      "INVALID_OPERATION",
      `operation must be one of: ${[...VALID_OPERATIONS].join(", ")}`,
      correlationId,
      { received: String(value) },
    );
  }
  return null;
}

/**
 * Validate the payload shape for a given operation.
 */
function validatePayload(
  operation: SorobanOperation,
  payload: unknown,
  correlationId: string,
): RetryQueueError | null {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return buildError(
      "INVALID_PAYLOAD",
      "payload must be a non-null object",
      correlationId,
      { received: typeof payload },
    );
  }

  const p = payload as Record<string, unknown>;

  if (typeof p.streamId !== "string" || p.streamId.trim().length === 0) {
    return buildError(
      "INVALID_PAYLOAD",
      "payload.streamId must be a non-empty string",
      correlationId,
      { received: p.streamId },
    );
  }

  if (operation === "createStream" && p.payload === undefined) {
    return buildError(
      "INVALID_PAYLOAD",
      "createStream operation requires payload.payload",
      correlationId,
    );
  }

  return null;
}

/**
 * Validate a queue entry ID.
 */
function validateEntryId(
  id: unknown,
  correlationId: string,
): RetryQueueError | null {
  if (typeof id !== "string" || id.trim().length === 0) {
    return buildError(
      "INVALID_ENTRY_ID",
      "entry ID must be a non-empty string",
      correlationId,
      { received: String(id) },
    );
  }
  return null;
}

/**
 * Validate the SorobanError passed to markFailed.
 */
function validateMarkFailedError(
  error: unknown,
  correlationId: string,
): RetryQueueError | null {
  if (!(error instanceof SorobanError)) {
    return buildError(
      "INVALID_ERROR",
      "error must be an instance of SorobanError",
      correlationId,
      { received: typeof error },
    );
  }
  return null;
}

/**
 * Validate queue configuration fields.
 */
function validateConfig(
  config: Partial<SorobanRetryQueueConfig>,
  correlationId: string,
): RetryQueueError | null {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return buildError(
        "INVALID_CONFIG",
        `${key} must be a non-negative finite number`,
        correlationId,
        { field: key, received: value },
      );
    }
  }
  if (
    config.maxRetries !== undefined &&
    !Number.isInteger(config.maxRetries)
  ) {
    return buildError(
      "INVALID_CONFIG",
      "maxRetries must be an integer",
      correlationId,
      { received: config.maxRetries },
    );
  }
  if (config.jitterFactor !== undefined && config.jitterFactor > 1) {
    return buildError(
      "INVALID_CONFIG",
      "jitterFactor must be in [0, 1]",
      correlationId,
      { received: config.jitterFactor },
    );
  }
  return null;
}

// =============================================================================
// Structured Logging
// =============================================================================

function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown>): void {
  const entry = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    service: "soroban-retry-queue",
    ...fields,
  });
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

// =============================================================================
// Backoff Calculation
// =============================================================================

/**
 * Compute the next retry delay using exponential backoff with jitter.
 *
 * Formula: `min(maxDelay, baseDelay * 2^attempt) * (1 ± jitterFactor)`
 *
 * @param attempt   - Zero-based retry attempt number.
 * @param config    - Active queue configuration.
 * @param random    - Source of randomness (injectable for tests).
 */
export function computeBackoff(
  attempt: number,
  config: SorobanRetryQueueConfig,
  random: () => number = Math.random,
): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = (random() - 0.5) * 2 * config.jitterFactor * capped;
  return Math.round(capped + jitter);
}

// =============================================================================
// Storage Interface (in-memory, swappable)
// =============================================================================

interface StorageAdapter {
  get(id: string): RetryQueueEntry | undefined;
  set(id: string, entry: RetryQueueEntry): void;
  delete(id: string): void;
  entries(): IterableIterator<[string, RetryQueueEntry]>;
  clear(): void;
}

class InMemoryStorage implements StorageAdapter {
  private store = new Map<string, RetryQueueEntry>();

  get(id: string): RetryQueueEntry | undefined {
    return this.store.get(id);
  }

  set(id: string, entry: RetryQueueEntry): void {
    this.store.set(id, entry);
  }

  delete(id: string): void {
    this.store.delete(id);
  }

  entries(): IterableIterator<[string, RetryQueueEntry]> {
    return this.store.entries();
  }

  clear(): void {
    this.store.clear();
  }
}

// =============================================================================
// Retry Queue
// =============================================================================

/**
 * Persistent Soroban retry queue.
 *
 * ## Usage
 *
 * ```ts
 * import { sorobanRetryQueue } from "@/lib/sorobanRetryQueue";
 *
 * // Enqueue a failed operation
 * const result = sorobanRetryQueue.enqueue("fetchStream", { streamId: "42" });
 * if (!result.ok) { / * handle error * / }
 *
 * // Later, dequeue and retry
 * const entry = sorobanRetryQueue.dequeue();
 * if (entry.ok && entry.data) {
 *   try {
 *     await onChainClient.fetchStream(entry.data.payload.streamId);
 *     sorobanRetryQueue.markComplete(entry.data.id);
 *   } catch (err) {
 *     sorobanRetryQueue.markFailed(entry.data.id, err);
 *   }
 * }
 * ```
 */
export const sorobanRetryQueue = {
  // ── State ──────────────────────────────────────────────────────────────

  _storage: new InMemoryStorage() as StorageAdapter,
  _config: { ...DEFAULT_RETRY_QUEUE_CONFIG },

  // ── Public Methods ─────────────────────────────────────────────────────

  /**
   * Enqueue a Soroban operation for retry.
   *
   * @param operation  - The Soroban operation name.
   * @param payload    - Operation-specific payload (must include `streamId`).
   * @param correlationId - Optional correlation ID; auto-generated if omitted.
   * @returns Result with the new entry's `id` on success.
   */
  enqueue<TOp extends SorobanOperation>(
    operation: TOp,
    payload: SorobanOperationPayloads[TOp],
    correlationId?: string,
  ): RetryQueueResult<{ id: string }> {
    const cid = correlationId ?? randomUUID();

    // Input validation
    const opErr = validateOperation(operation, cid);
    if (opErr) {
      log("warn", "retry_queue_enqueue_validation_failed", {
        correlation_id: cid,
        error_code: opErr.code,
        error_message: opErr.message,
      });
      return { ok: false, error: opErr };
    }

    const payloadErr = validatePayload(operation, payload, cid);
    if (payloadErr) {
      log("warn", "retry_queue_enqueue_validation_failed", {
        correlation_id: cid,
        error_code: payloadErr.code,
        error_message: payloadErr.message,
      });
      return { ok: false, error: payloadErr };
    }

    const id = `soroban-retry-${randomUUID()}`;
    const now = new Date().toISOString();

    const entry: RetryQueueEntry = {
      id,
      operation,
      payload,
      attempts: 0,
      maxAttempts: this._config.maxRetries,
      nextRetryAt: Date.now(), // Eligible immediately
      lastError: null,
      status: "pending",
      correlationId: cid,
      createdAt: now,
      updatedAt: now,
    };

    this._storage.set(id, entry);

    log("info", "retry_queue_enqueued", {
      correlation_id: cid,
      entry_id: id,
      operation,
      stream_id: (payload as { streamId: string }).streamId,
    });

    return { ok: true, data: { id } };
  },

  /**
   * Dequeue the next eligible entry (FIFO by `nextRetryAt`).
   *
   * Only returns entries whose `nextRetryAt <= now` and status is
   * `"pending"`. The entry is transitioned to `"processing"`.
   *
   * @param now - Current timestamp for test determinism.
   * @returns Result with the dequeued entry or `null` if nothing is ready.
   */
  dequeue(
    now: number = Date.now(),
  ): RetryQueueResult<RetryQueueEntry | null> {
    const cid = randomUUID();
    // Clamp now to a valid Date range. Infinity / NaN cause Date#toISOString
    // to throw, and tests pass Infinity as a sentinel for "any time".
    const safeNow = Number.isFinite(now) ? now : 4_000_000_000_000;

    let oldest: RetryQueueEntry | null = null;

    for (const [, entry] of this._storage.entries()) {
      if (entry.status !== "pending") continue;
      if (entry.nextRetryAt > now) continue;
      if (!oldest || entry.nextRetryAt < oldest.nextRetryAt) {
        oldest = entry;
      }
    }

    if (!oldest) {
      return { ok: true, data: null };
    }

    // Atomically transition to processing
    oldest.status = "processing";
    oldest.updatedAt = new Date(safeNow).toISOString();
    this._storage.set(oldest.id, oldest);

    log("info", "retry_queue_dequeued", {
      correlation_id: oldest.correlationId,
      entry_id: oldest.id,
      operation: oldest.operation,
      attempts: oldest.attempts,
      max_attempts: oldest.maxAttempts,
      stream_id: (oldest.payload as { streamId: string }).streamId,
    });

    return { ok: true, data: { ...oldest } };
  },

  /**
   * Mark a dequeued entry as successfully completed. Removes the entry
   * from the queue.
   *
   * @param id - Entry ID returned by `dequeue()`.
   */
  markComplete(id: string): RetryQueueResult {
    const cid = randomUUID();

    const idErr = validateEntryId(id, cid);
    if (idErr) {
      return { ok: false, error: idErr };
    }

    const entry = this._storage.get(id);
    if (!entry) {
      return {
        ok: false,
        error: buildError("NOT_FOUND", `entry ${id} not found`, cid),
      };
    }

    if (entry.status !== "processing") {
      return {
        ok: false,
        error: buildError(
          "INVALID_STATE",
          `entry ${id} is not in processing state (current: ${entry.status})`,
          cid,
        ),
      };
    }

    this._storage.delete(id);

    log("info", "retry_queue_completed", {
      correlation_id: entry.correlationId,
      entry_id: id,
      operation: entry.operation,
      total_attempts: entry.attempts,
    });

    return { ok: true };
  },

  /**
   * Record a failed retry attempt. If the entry has remaining retries,
   * schedule the next attempt with exponential backoff. Otherwise, move
   * the entry to the dead-letter queue.
   *
   * @param id    - Entry ID returned by `dequeue()`.
   * @param error - The `SorobanError` that caused the failure.
   * @param now   - Current timestamp for test determinism.
   */
  markFailed(
    id: string,
    error: unknown,
    now: number = Date.now(),
  ): RetryQueueResult<{ status: "pending" | "dead"; nextRetryAt?: number }> {
    const cid = randomUUID();

    const safeNow = Number.isFinite(now) ? now : 4_000_000_000_000;

    // Validate inputs
    const idErr = validateEntryId(id, cid);
    if (idErr) {
      return { ok: false, error: idErr };
    }

    const errErr = validateMarkFailedError(error, cid);
    if (errErr) {
      return { ok: false, error: errErr };
    }

    const entry = this._storage.get(id);
    if (!entry) {
      return {
        ok: false,
        error: buildError("NOT_FOUND", `entry ${id} not found`, cid),
      };
    }

    if (entry.status !== "processing") {
      return {
        ok: false,
        error: buildError(
          "INVALID_STATE",
          `entry ${id} is not in processing state (current: ${entry.status})`,
          cid,
        ),
      };
    }

    const sorobanErr = error as SorobanError;
    entry.attempts += 1;
    entry.lastError = sorobanErr;

    // SECURITY: Never log raw error messages that may contain PII or
    // contract internals. Only stable variant codes are logged.
    if (entry.attempts >= entry.maxAttempts) {
      // Retries exhausted → dead letter
      entry.status = "dead";
      entry.updatedAt = new Date(safeNow).toISOString();
      this._storage.set(id, entry);

      log("error", "retry_queue_exhausted", {
        correlation_id: entry.correlationId,
        entry_id: id,
        operation: entry.operation,
        attempts: entry.attempts,
        max_attempts: entry.maxAttempts,
        last_error_variant: sorobanErr.variant,
      });

      return { ok: true, data: { status: "dead" } };
    }

    // Schedule next retry with exponential backoff + jitter
    const delay = computeBackoff(entry.attempts - 1, this._config);
    entry.status = "pending";
    entry.nextRetryAt = safeNow + delay;
    entry.updatedAt = new Date(safeNow).toISOString();
    this._storage.set(id, entry);

    log("warn", "retry_queue_retry_scheduled", {
      correlation_id: entry.correlationId,
      entry_id: id,
      operation: entry.operation,
      attempt: entry.attempts,
      max_attempts: entry.maxAttempts,
      delay_ms: delay,
      next_retry_at: new Date(entry.nextRetryAt).toISOString(),
      last_error_variant: sorobanErr.variant,
    });

    return { ok: true, data: { status: "pending", nextRetryAt: entry.nextRetryAt } };
  },

  /**
   * Return the number of entries in `"pending"` status.
   */
  getQueueDepth(): number {
    let count = 0;
    for (const [, entry] of this._storage.entries()) {
      if (entry.status === "pending") count++;
    }
    return count;
  },

  /**
   * Return all entries in `"dead"` status (retries exhausted).
   */
  getDeadLetterEntries(): RetryQueueEntry[] {
    const dead: RetryQueueEntry[] = [];
    for (const [, entry] of this._storage.entries()) {
      if (entry.status === "dead") {
        dead.push({ ...entry });
      }
    }
    // Sort by updatedAt descending so newest dead letters appear first.
    dead.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return dead;
  },

  /**
   * Move a dead-letter entry back to `"pending"` for manual retry.
   * Resets `attempts` to 0 and clears `lastError`.
   *
   * @param id - Entry ID to requeue.
   */
  requeueDeadLetter(id: string): RetryQueueResult {
    const cid = randomUUID();

    const idErr = validateEntryId(id, cid);
    if (idErr) {
      return { ok: false, error: idErr };
    }

    const entry = this._storage.get(id);
    if (!entry) {
      return {
        ok: false,
        error: buildError("NOT_FOUND", `entry ${id} not found`, cid),
      };
    }

    if (entry.status !== "dead") {
      return {
        ok: false,
        error: buildError(
          "INVALID_STATE",
          `entry ${id} is not in dead state (current: ${entry.status})`,
          cid,
        ),
      };
    }

    entry.status = "pending";
    entry.attempts = 0;
    entry.lastError = null;
    entry.nextRetryAt = Date.now();
    entry.updatedAt = new Date().toISOString();
    this._storage.set(id, entry);

    log("info", "retry_queue_dead_letter_requeued", {
      correlation_id: entry.correlationId,
      entry_id: id,
      operation: entry.operation,
    });

    return { ok: true };
  },

  /**
   * Inspect a single entry by ID (read-only snapshot).
   *
   * @param id - Entry ID.
   * @returns A defensive copy of the entry, or `null` if not found.
   */
  getEntry(id: string): RetryQueueResult<RetryQueueEntry | null> {
    const cid = randomUUID();

    const idErr = validateEntryId(id, cid);
    if (idErr) {
      return { ok: false, error: idErr };
    }

    const entry = this._storage.get(id);
    if (!entry) {
      return { ok: true, data: null };
    }

    return { ok: true, data: { ...entry } };
  },

  /**
   * Override queue configuration. Only provided fields are updated;
   * omitted fields retain their current values.
   */
  setConfig(
    partial: Partial<SorobanRetryQueueConfig>,
  ): RetryQueueResult {
    const cid = randomUUID();

    const cfgErr = validateConfig(partial, cid);
    if (cfgErr) {
      return { ok: false, error: cfgErr };
    }

    this._config = { ...this._config, ...partial };

    log("info", "retry_queue_config_updated", {
      correlation_id: cid,
      config: { ...this._config },
    });

    return { ok: true };
  },

  /**
   * Return a defensive copy of the current configuration.
   */
  getConfig(): SorobanRetryQueueConfig {
    return { ...this._config };
  },

  /**
   * Reset all state — queue entries and configuration — to defaults.
   * Intended for test setup/teardown only.
   */
  clear(): void {
    this._storage.clear();
    this._config = { ...DEFAULT_RETRY_QUEUE_CONFIG };
  },
};
