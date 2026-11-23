/**
 * indexerStatus.ts
 *
 * Deterministic indexer status state machine.
 *
 * The Horizon indexer is long-running and can silently fall behind the chain
 * tip. To make normal operation and adverse conditions reviewable, the indexer
 * status is derived from a small set of telemetry inputs through a *pure, total,
 * deterministic* transition function. There is exactly one transition rule per
 * state and the rules are evaluated in a fixed, documented priority order, so
 * the same telemetry always yields the same status — even under retries,
 * partial failures, and cursor stall boundaries.
 *
 * ## State model
 *
 * ```
 * loading   cursor has never advanced (first poll in flight)
 * synced    running and advancing, lag within tolerance
 * syncing   running and advancing, but lag above tolerance
 * stalled   running but the cursor has not advanced within stallThresholdMs
 * stopped   main loop is not running, or the breaker is open (permission)
 * error     last failure is fatal / unrecoverable
 * retrying  last attempt failed but a backoff retry is scheduled (recoverable)
 * ```
 *
 * ## Transition priority (highest wins)
 *
 * 1. `breakerOpen`            → `stopped`  (permission: ingestion is suspended)
 * 2. `!running`               → `stopped`
 * 3. `failure === "fatal"`    → `error`    (diagnosability before staleness)
 * 4. `failure === "retrying"` → `retrying` (recoverable backoff)
 * 5. stale (cursor stagnant)  → `stalled`  (explicit stale-state transition)
 * 6. never advanced           → `loading`
 * 7. within lag tolerance     → `synced`   (else `syncing`)
 *
 * ## Invariants
 *
 * - `deriveIndexerStatus` is pure: it never mutates state, reads the clock, or
 *   throws. All time values are supplied by the caller (`now`), making the
 *   result reproducible in tests.
 * - While `running && !breakerOpen`, a cursor that has not advanced past the
 *   stall threshold **must** report `stalled` and can never silently report
 *   `synced` / `syncing`. `isStale` is the single source of truth for that
 *   transition and is exposed independently for callers that only need the
 *   predicate (e.g. logging or alerting).
 * - `isStale` uses a strictly-greater-than comparison against the threshold, so
 *   the boundary `now - lastProcessedAt === stallThresholdMs` is NOT yet stale.
 *   A zero or negative threshold disables staleness detection (never stale).
 * - Input validation is explicit and safe: unknown `failure` values, negative
 *   lag, and negative timestamps are normalized to well-defined defaults rather
 *   than producing inconsistent states.
 */

/** Possible indexer lifecycle states. */
export type IndexerStatusState =
  | "loading"
  | "syncing"
  | "synced"
  | "stalled"
  | "stopped"
  | "error"
  | "retrying";

/** Disposition of the most recent ingestion failure. */
export type IndexerFailure = "none" | "fatal" | "retrying";

/** Telemetry inputs consumed by the status transition function. */
export interface IndexerTelemetry {
  /** Whether the indexer main loop is currently running. */
  running: boolean;
  /**
   * Whether the indexer circuit breaker is open (permission suspended).
   * See `isCircuitBreakerOpen("indexer")`.
   */
  breakerOpen: boolean;
  /**
   * Epoch ms of the last successful cursor advance, or `null` when the cursor
   * has never advanced (still loading).
   */
  lastProcessedAt: number | null;
  /** Epoch ms "now". Supplied by the caller for deterministic transitions. */
  now: number;
  /** Stall threshold in ms. Cursor stagnation past this becomes `stalled`. */
  stallThresholdMs: number;
  /** Latest failure disposition. */
  failure: IndexerFailure;
  /** Current lag in ledgers (`latestLedger - lastProcessedLedger`). */
  lagLedgers: number;
  /** Maximum lag (in ledgers) still considered `synced`. Defaults to 2. */
  syncToleranceLedgers: number;
}

/**
 * Pure predicate: has the cursor gone stale?
 *
 * A cursor is stale only while it has advanced at least once and has not
 * advanced again within `stallThresholdMs`. A null `lastProcessedAt` (no
 * cursor yet) is deliberately NOT stale — that is the `loading` condition.
 *
 * Uses strict `>` so the exact threshold boundary is still "fresh".
 * A non-positive threshold disables staleness detection.
 */
export function isStale(
  lastProcessedAt: number | null,
  now: number,
  stallThresholdMs: number,
): boolean {
  if (lastProcessedAt == null) return false;
  if (stallThresholdMs <= 0) return false;
  return now - lastProcessedAt > stallThresholdMs;
}

const DEFAULT_SYNC_TOLERANCE = 2;

/** Normalizes a raw `failure` value; unknown values become `"none"`. */
function normalizeFailure(raw: IndexerFailure): IndexerFailure {
  if (raw === "fatal" || raw === "retrying" || raw === "none") return raw;
  return "none";
}

/** Normalizes lag to a non-negative integer. */
function normalizeLag(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

/** Normalizes sync tolerance to a non-negative integer. */
function normalizeTolerance(raw: number): number {
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SYNC_TOLERANCE;
  return Math.floor(raw);
}

/**
 * Deterministically derive the current indexer status from telemetry.
 *
 * See the module doc for the exact priority order. This function is pure and
 * total: any reasonable `IndexerTelemetry` produces a valid status.
 */
export function deriveIndexerStatus(
  telemetry: IndexerTelemetry,
): IndexerStatusState {
  // 1. Permission / suspended: breaker open gates everything.
  if (telemetry.breakerOpen) return "stopped";

  // 2. Main loop not running.
  if (!telemetry.running) return "stopped";

  // 3/4. Failure dispositions take precedence over staleness so the operator
  //      sees the actionable reason (error / retrying) rather than a stall.
  const failure = normalizeFailure(telemetry.failure);
  if (failure === "fatal") return "error";
  if (failure === "retrying") return "retrying";

  // 5. Explicit stale-state transition.
  if (isStale(telemetry.lastProcessedAt, telemetry.now, telemetry.stallThresholdMs)) {
    return "stalled";
  }

  // 6. Never advanced => still loading.
  if (telemetry.lastProcessedAt == null) return "loading";

  // 7. Steady state driven by lag.
  const lag = normalizeLag(telemetry.lagLedgers);
  const tolerance = normalizeTolerance(telemetry.syncToleranceLedgers);
  return lag <= tolerance ? "synced" : "syncing";
}

/**
 * Human-readable reason for the transition rule that produced `state`.
 *
 * Useful for logs and user-visible diagnostics. Mirrors the priority order in
 * `deriveIndexerStatus` and always returns a non-empty, stable message so
 * failures are diagnosable without the operator having to re-derive state.
 */
export function describeIndexerStatus(status: IndexerStatusState): string {
  switch (status) {
    case "stopped":
      return "Indexer is stopped or ingestion is suspended (circuit breaker open).";
    case "error":
      return "Indexer is in a fatal error state. Recovery requires intervention.";
    case "retrying":
      return "Indexer encountered a transient error and is retrying.";
    case "stalled":
      return "Indexer cursor has not advanced within the stall threshold; it is stale.";
    case "loading":
      return "Indexer has started but has not processed its first ledger yet.";
    case "syncing":
      return "Indexer is running and catching up to the chain tip.";
    case "synced":
      return "Indexer is synced to the chain tip within tolerance.";
  }
}
