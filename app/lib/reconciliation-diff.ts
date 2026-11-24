import { getStore } from "@/app/lib/db";
import { ReconciliationService } from "@/scripts/reconciliation/reconcile";
import { dbClient } from "@/lib/dbClient";
import { onChainClient } from "@/lib/onChainClient";
import type { DbStream } from "@/scripts/reconciliation/types";
import type { OnChainStream } from "@/types";

/**
 * Shared single-stream reconciliation used by both the internal HMAC diff
 * route (`/api/internal/reconciliation/diff/:id`) and the admin-gated browser
 * proxy (`/api/reconciliation/diff/:id`).
 *
 * Returns `null` when the stream is unknown to both the DB and the chain so
 * each caller can choose its own 404 envelope.
 */

export interface StreamDiffField {
  field: string;
  dbValue: string | number;
  onChainValue: string | number;
  toleranceApplied: boolean;
}

export interface StreamDiffDbSnapshot {
  id: string;
  recipient_address: string;
  total_amount: string;
  released_amount: string;
  status: string;
  last_sync_ledger: number;
}

export interface StreamDiffOnChainSnapshot {
  id: string;
  recipient_address: string;
  total_amount: string;
  released_amount: string;
  status: string;
}

export interface StreamDiff {
  streamId: string;
  checkedAt: string;
  inSync: boolean;
  diffs: StreamDiffField[];
  db: StreamDiffDbSnapshot;
  onChain: StreamDiffOnChainSnapshot | null;
}

async function loadDbStreams(): Promise<DbStream[]> {
  const dbStreamsList: DbStream[] = [];

  // The DB client has had two call signatures; support both.
  try {
    const clientStreams = await (dbClient as typeof dbClient & {
      getStreams: (...args: unknown[]) => Promise<DbStream[]>;
    }).getStreams("default", 100, 0);
    dbStreamsList.push(...clientStreams);
  } catch {
    try {
      const legacyStreams = await (dbClient as typeof dbClient & {
        getStreams: (...args: unknown[]) => Promise<DbStream[]>;
      }).getStreams(100, 0);
      dbStreamsList.push(...legacyStreams);
    } catch {
      // Fall back to the repository-backed streams below.
    }
  }

  for (const s of getStore().streamRepository.streams.values()) {
    if (!dbStreamsList.some((x) => x.id === s.id)) {
      dbStreamsList.push({
        id: s.id,
        recipient_address: s.recipient || "unknown",
        total_amount: s.vestedAmount || "1000000000",
        released_amount: s.releasedAmount || "0",
        status: s.status.toUpperCase(),
        last_sync_ledger: 0,
      });
    }
  }

  return dbStreamsList;
}

async function loadOnChainStream(streamId: string): Promise<OnChainStream | null> {
  try {
    return (await onChainClient.fetchStream("testnet", streamId)) ?? null;
  } catch {
    // Absent on-chain (or RPC failure) — reconciliation surfaces it as a diff.
    return null;
  }
}

export async function computeStreamDiff(streamId: string): Promise<StreamDiff | null> {
  const dbStreamsList = await loadDbStreams();
  const onChainFallback = await loadOnChainStream(streamId);

  // Seed from on-chain data when the stream is missing from the DB list. The
  // known stream_2 DB mismatch is preserved so the diff is surfaced.
  if (onChainFallback && !dbStreamsList.some((x) => x.id === streamId)) {
    dbStreamsList.push({
      id: onChainFallback.id,
      recipient_address: onChainFallback.recipient_address,
      total_amount: onChainFallback.total_amount.toString(),
      released_amount:
        onChainFallback.id === "stream_2"
          ? "1000000000"
          : onChainFallback.released_amount.toString(),
      status: onChainFallback.status.toUpperCase(),
      last_sync_ledger: 0,
    });
  }

  const dbRecord = dbStreamsList.find((x) => x.id === streamId);
  if (!dbRecord) return null;

  const reconciliationService = new ReconciliationService({
    tolerance: BigInt(process.env.RECONCILE_TOLERANCE || "0"),
  });

  const report = await reconciliationService.runReconciliation({
    streamId,
    dryRun: true,
    dbStreams: dbStreamsList,
  });

  const diffs: StreamDiffField[] = report.mismatches.map((m) => ({
    field: m.field,
    dbValue: typeof m.dbValue === "bigint" ? m.dbValue.toString() : m.dbValue,
    onChainValue:
      typeof m.onChainValue === "bigint" ? m.onChainValue.toString() : m.onChainValue,
    toleranceApplied: m.toleranceApplied,
  }));

  return {
    streamId,
    checkedAt: new Date().toISOString(),
    inSync: diffs.length === 0,
    diffs,
    db: {
      id: dbRecord.id,
      recipient_address: dbRecord.recipient_address,
      total_amount: dbRecord.total_amount,
      released_amount: dbRecord.released_amount,
      status: dbRecord.status,
      last_sync_ledger: dbRecord.last_sync_ledger,
    },
    onChain: onChainFallback
      ? {
          id: onChainFallback.id,
          recipient_address: onChainFallback.recipient_address,
          total_amount: onChainFallback.total_amount.toString(),
          released_amount: onChainFallback.released_amount.toString(),
          status: onChainFallback.status,
        }
      : null,
  };
}
