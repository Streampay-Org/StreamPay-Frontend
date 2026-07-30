/**
 * Reconciliation data layer. Pure helpers + fetcher stubs the route composes.
 * Kept in a sibling module so the route can be unit-tested by mocking this file.
 */

export interface DBRow { id: string; amount: string; status: string; createdAt: string }
export interface IndexerRow { id: string; amount: string; status: string; ledgerSeq: number }

export async function fetchAllDBRows(_sinceISO: string, _pageSize: number): Promise<DBRow[]> {
  return [];
}

export async function fetchAllIndexerRows(_sinceISO: string, _pageSize: number): Promise<IndexerRow[]> {
  return [];
}

export interface ReconciliationDiff {
  missingInIndexer: Array<{ id: string; amount: string; createdAt: string }>;
  missingInDB: Array<{ id: string; amount: string; ledgerSeq: number }>;
  mismatchedAmount: Array<{ id: string; dbAmount: string; indexerAmount: string }>;
  mismatchedStatus: Array<{ id: string; dbStatus: string; indexerStatus: string }>;
}
export interface ReconciliationSummary {
  totalDBRows: number;
  totalIndexerRows: number;
  missingInIndexerCount: number;
  missingInDBCount: number;
  mismatchedAmountCount: number;
  mismatchedStatusCount: number;
}

export function diffRows(
  db: DBRow[],
  indexer: IndexerRow[],
): { diff: ReconciliationDiff; summary: ReconciliationSummary } {
  const dbById = new Map(db.map((r) => [r.id, r]));
  const idxById = new Map(indexer.map((r) => [r.id, r]));
  const missingInIndexer: ReconciliationDiff["missingInIndexer"] = [];
  const missingInDB: ReconciliationDiff["missingInDB"] = [];
  const mismatchedAmount: ReconciliationDiff["mismatchedAmount"] = [];
  const mismatchedStatus: ReconciliationDiff["mismatchedStatus"] = [];
  for (const [id, d] of dbById) {
    const i = idxById.get(id);
    if (!i) { missingInIndexer.push({ id, amount: d.amount, createdAt: d.createdAt }); continue; }
    if (d.amount !== i.amount) mismatchedAmount.push({ id, dbAmount: d.amount, indexerAmount: i.amount });
    if (d.status !== i.status) mismatchedStatus.push({ id, dbStatus: d.status, indexerStatus: i.status });
  }
  for (const [id, i] of idxById) {
    if (!dbById.has(id)) missingInDB.push({ id, amount: i.amount, ledgerSeq: i.ledgerSeq });
  }
  return {
    diff: { missingInIndexer, missingInDB, mismatchedAmount, mismatchedStatus },
    summary: {
      totalDBRows: db.length,
      totalIndexerRows: indexer.length,
      missingInIndexerCount: missingInIndexer.length,
      missingInDBCount: missingInDB.length,
      mismatchedAmountCount: mismatchedAmount.length,
      mismatchedStatusCount: mismatchedStatus.length,
    },
  };
}