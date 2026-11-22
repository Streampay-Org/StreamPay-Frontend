import { dbClient } from '../../lib/dbClient';
import { onChainClient } from '../../lib/onChainClient';
import { DbStream, KindReportSummary, ReconciliationDiff, ReconciliationReport, StreamKind } from './types';
import { OnChainStream } from '../../types';
import { mapDbStream, mapOnChainStream } from '../../mapping';
import { EscrowInvariants } from '../../escrow-invariants';

/**
 * Normalise a DB stream's comparable total amount as a `bigint` based on its kind:
 * - `standard`: `BigInt(dbStream.total_amount)`
 * - `split`: `BigInt(dbStream.total ?? dbStream.total_amount)`
 * - `recurring`: `BigInt(amount_per_cycle) * BigInt(total_cycles)` when both are
 *   present, otherwise `BigInt(dbStream.total_amount)`.
 */
export function normalizeDbTotalAmount(dbStream: DbStream): bigint {
  const kind: StreamKind = dbStream.kind ?? 'standard';
  if (kind === 'split') {
    return BigInt(dbStream.total ?? dbStream.total_amount);
  }
  if (
    kind === 'recurring' &&
    dbStream.amount_per_cycle !== undefined &&
    dbStream.total_cycles !== undefined
  ) {
    return BigInt(dbStream.amount_per_cycle) * BigInt(dbStream.total_cycles);
  }
  return BigInt(dbStream.total_amount);
}

export class ReconciliationService {
  private tolerance: bigint = 0n; // Set tolerance for rounding if necessary

  constructor(options: { tolerance?: bigint } = {}) {
    this.tolerance = options.tolerance ?? 0n;
  }

  public async runReconciliation(options?: { streamId?: string; dryRun?: boolean; dbStreams?: DbStream[]; signal?: AbortSignal }): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      timestamp: new Date().toISOString(),
      totalStreamsChecked: 0,
      mismatches: [],
      errors: [],
      status: 'SUCCESS',
    };

    const byKind: Partial<Record<StreamKind, KindReportSummary>> = {};
    let hasNonStandard = false;

    const recordStreamChecked = (dbStream: DbStream): StreamKind => {
      const kind: StreamKind = dbStream.kind ?? 'standard';
      if (kind !== 'standard') hasNonStandard = true;
      if (!byKind[kind]) {
        byKind[kind] = { totalStreamsChecked: 0, mismatchCount: 0, errorCount: 0 };
      }
      byKind[kind]!.totalStreamsChecked++;
      return kind;
    };

    const streamId = options?.streamId;
    const dryRun = options?.dryRun ?? false;
    const inputDbStreams = options?.dbStreams;
    const signal = options?.signal;

    if (inputDbStreams) {
      // Reconcile over the provided streams
      const targetStreams = streamId 
        ? inputDbStreams.filter(s => s.id === streamId)
        : inputDbStreams;

      if (streamId && targetStreams.length === 0) {
        report.errors.push({ streamId, error: "Stream not found in DB" });
      } else {
        for (const dbStream of targetStreams) {
          if (signal?.aborted) {
            report.status = 'FAILED';
            report.errors.push({ streamId: dbStream.id, error: 'Reconciliation aborted before this stream was checked.' });
            return this.finalizeKindFields(report, byKind, hasNonStandard);
          }
          report.totalStreamsChecked++;
          const kind = recordStreamChecked(dbStream);
          const beforeMismatches = report.mismatches.length;
          try {
            await this.reconcileSingleStream(dbStream, report, kind);
            byKind[kind]!.mismatchCount += report.mismatches.length - beforeMismatches;
          } catch (err) {
            byKind[kind]!.errorCount++;
            report.errors.push({
              streamId: dbStream.id,
              kind,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } else {
      // Reconcile over dbClient streams
      if (streamId) {
        // Process a single stream
        try {
          const dbStream = await dbClient.getStreamById(streamId);
          if (!dbStream) {
            report.errors.push({ streamId, error: "Stream not found in DB" });
          } else {
            report.totalStreamsChecked++;
            const kind = recordStreamChecked(dbStream);
            const beforeMismatches = report.mismatches.length;
            await this.reconcileSingleStream(dbStream, report, kind);
            byKind[kind]!.mismatchCount += report.mismatches.length - beforeMismatches;
          }
        } catch (err) {
          report.errors.push({
            streamId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        // Process all streams using pagination
        let offset = 0;
        const limit = 50;
        let hasMore = true;

        while (hasMore) {
          if (signal?.aborted) {
            report.status = 'FAILED';
            report.errors.push({ streamId: 'all-streams', error: 'Reconciliation aborted before completion.' });
            return this.finalizeKindFields(report, byKind, hasNonStandard);
          }
          let dbStreams: DbStream[] = [];
          try {
            dbStreams = await dbClient.getStreams(limit, offset);
          } catch (err) {
            report.status = 'FAILED';
            report.errors.push({
              streamId: 'all-streams-fetch',
              error: err instanceof Error ? err.message : String(err),
            });
            break;
          }

          if (dbStreams.length === 0) {
            hasMore = false;
            break;
          }

          for (const dbStream of dbStreams) {
            if (signal?.aborted) {
              report.status = 'FAILED';
              report.errors.push({ streamId: dbStream.id, error: 'Reconciliation aborted before this stream was checked.' });
              return this.finalizeKindFields(report, byKind, hasNonStandard);
            }
            report.totalStreamsChecked++;
            const kind = recordStreamChecked(dbStream);
            const beforeMismatches = report.mismatches.length;
            try {
              await this.reconcileSingleStream(dbStream, report, kind);
              byKind[kind]!.mismatchCount += report.mismatches.length - beforeMismatches;
            } catch (err) {
              byKind[kind]!.errorCount++;
              report.errors.push({
                streamId: dbStream.id,
                kind,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          offset += limit;
          if (dbStreams.length < limit) hasMore = false;
        }
      }
    }

    if (report.mismatches.length > 0 || report.errors.length > 0) {
      report.status = report.errors.length > 0 ? 'FAILED' : 'MISMATCH_FOUND';
    }

    if (!dryRun && !signal?.aborted) {
      try {
        await dbClient.updateLastRunStatus(report.status, Date.now());
      } catch (err) {
        console.error("Failed to update last run status in DB:", err);
      }
    }

    return this.finalizeKindFields(report, byKind, hasNonStandard);
  }

  private finalizeKindFields(
    report: ReconciliationReport,
    byKind: Partial<Record<StreamKind, KindReportSummary>>,
    hasNonStandard: boolean,
  ): ReconciliationReport {
    if (hasNonStandard) {
      report.byKind = byKind;
      return report;
    }
    // Preserve exact standard-only output shape (no `kind` or `byKind` keys)
    for (const m of report.mismatches) {
      delete m.kind;
    }
    for (const e of report.errors) {
      delete e.kind;
    }
    return report;
  }

  private async reconcileSingleStream(dbStream: DbStream, report: ReconciliationReport, kind: StreamKind): Promise<void> {
    let onChainStream: OnChainStream | null = null;
    try {
      onChainStream = await onChainClient.fetchStream('testnet', dbStream.id);
    } catch (err) {
      if (
        (err && typeof err === "object" && "variant" in err && (err as any).variant === "StreamNotFound") ||
        (err && typeof err === "object" && "code" in err && ((err as any).code === "STREAM_NOT_FOUND" || (err as any).code === "StreamNotFound")) ||
        (err instanceof Error && err.message.includes("does not exist on-chain"))
      ) {
        onChainStream = null;
      } else {
        throw err;
      }
    }
    if (!onChainStream) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'presence',
        dbValue: 'exists',
        onChainValue: 'missing',
        toleranceApplied: false,
      });
      return;
    }

    // Assert Escrow Invariants
    const invariantCheck = EscrowInvariants.validateBalances(onChainStream);
    if (!invariantCheck.isValid) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'escrow-invariant',
        dbValue: 'valid',
        onChainValue: `violated: ${invariantCheck.error}`,
        toleranceApplied: false,
      });
    }

    // Compare fields mapped via mapping.ts
    const dbMapped = mapDbStream(dbStream);
    const chainMapped = mapOnChainStream(onChainStream);
    const dbTotalAmount = normalizeDbTotalAmount(dbStream);

    // Compare total_amount
    if (this.isMismatch(dbTotalAmount, chainMapped.totalAmount)) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'total_amount',
        dbValue: dbTotalAmount,
        onChainValue: chainMapped.totalAmount,
        toleranceApplied: this.tolerance > 0n,
      });
    }

    // Compare released_amount
    if (this.isMismatch(dbMapped.releasedAmount, chainMapped.releasedAmount)) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'released_amount',
        dbValue: dbMapped.releasedAmount,
        onChainValue: chainMapped.releasedAmount,
        toleranceApplied: this.tolerance > 0n,
      });
    }

    // Compare status (case-insensitive for safety, though they should match)
    if (dbMapped.status.toUpperCase() !== chainMapped.status.toUpperCase()) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'status',
        dbValue: dbMapped.status,
        onChainValue: chainMapped.status,
        toleranceApplied: false,
      });
    }

    // Compare recipient address
    if (dbMapped.recipientAddress !== chainMapped.recipientAddress) {
      report.mismatches.push({
        streamId: dbStream.id,
        kind,
        field: 'recipient_address',
        dbValue: dbMapped.recipientAddress,
        onChainValue: chainMapped.recipientAddress,
        toleranceApplied: false,
      });
    }
  }

  private isMismatch(dbValue: bigint, chainValue: bigint): boolean {
    const diff = dbValue > chainValue ? dbValue - chainValue : chainValue - dbValue;
    return diff > this.tolerance;
  }
}
