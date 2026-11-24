/**
 * Indexer status service (internal to `/api/indexer/status`).
 *
 * Builds the deterministic indexer status payload consumed by the SSE route.
 * The derivation itself lives in the pure state machine `lib/indexerStatus.ts`;
 * this module only wires it to the real cursor store, the operator circuit
 * breaker, and configuration.
 */

import { isCircuitBreakerOpen } from "@/app/lib/admin-guard";
import { deriveIndexerStatus, isStale, type IndexerStatusState } from "@/lib/indexerStatus";
import { cursorsDb } from "@/lib/indexer";

/** The network this status endpoint reports for. */
export const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

export interface IndexerStatus {
  network: string;
  ledgerCursor: number;
  lagMs: number;
  queueDepth: number;
  syncedAt: string;
  /**
   * True when an admin has tripped the indexer circuit breaker via
   * POST /api/admin/circuit-breaker. Ingestion is halted; cursor and lag
   * are frozen at their last values and will not advance until reset.
   */
  breakerOpen: boolean;
  /**
   * Deterministic lifecycle state derived from real telemetry. Never derived
   * from randomness — see `deriveIndexerStatus` in `lib/indexerStatus.ts`.
   */
  status: IndexerStatusState;
  /** Explicit stale flag: cursor has not advanced within the stall threshold. */
  stale: boolean;
  /** Human-readable reason, safe to surface to operators. */
  message: string;
}

export function statusMessage(status: IndexerStatusState): string {
  return {
    stopped: "Indexer is stopped or ingestion is suspended (circuit breaker open).",
    error: "Indexer is in a fatal error state and needs intervention.",
    retrying: "Indexer hit a transient error and is retrying.",
    stalled: "Indexer cursor has not advanced within the stall threshold.",
    loading: "Indexer has not processed its first ledger yet.",
    syncing: "Indexer is running and catching up to the chain tip.",
    synced: "Indexer is synced to the chain tip.",
  }[status];
}

export function getIndexerStatus(): IndexerStatus {
  const state = cursorsDb.get(NETWORK);
  const lastUpdatedAt = state ? state.lastUpdatedAt : null;
  const lastLedger = state ? state.lastLedger : 0;
  const now = Date.now();
  // STALL_THRESHOLD_MS defaults to 5 minutes (300000) unless configured.
  const stallThresholdMs = Number(process.env.STALL_THRESHOLD_MS ?? 300_000);
  // The status endpoint reports for a live poller; the circuit breaker is the
  // authoritative operator override for "stopped".
  const breakerOpen = isCircuitBreakerOpen("indexer");

  const status = deriveIndexerStatus({
    running: !breakerOpen,
    breakerOpen,
    lastProcessedAt: lastUpdatedAt,
    now,
    stallThresholdMs,
    failure: "none",
    lagLedgers: lastLedger === 0 ? 0 : 1, // informational; no live tip source
    syncToleranceLedgers: 2,
  });
  const stale = isStale(lastUpdatedAt, now, stallThresholdMs);

  return {
    network: NETWORK,
    ledgerCursor: lastLedger,
    lagMs: stale ? stallThresholdMs : 0,
    queueDepth: 0,
    syncedAt: lastUpdatedAt ? new Date(lastUpdatedAt).toISOString() : "",
    breakerOpen,
    status,
    stale,
    message: statusMessage(status),
  };
}
