/**
 * Reconciliation data layer. Pure helpers + fetcher stubs the route composes.
 * Kept in a sibling module so the route can be unit-tested by mocking this file.
 */

export type StreamKind = "standard" | "split" | "recurring";

export const STREAM_KINDS: readonly StreamKind[] = [
  "standard",
  "split",
  "recurring",
] as const;

export interface DBRow {
  id: string;
  /** Stream kind; defaults to `"standard"` when omitted. */
  kind?: StreamKind | string;
  amount: string;
  status: string;
  createdAt: string;
  /** Split stream total alias (normalised against `total_amount` / `amount`). */
  total?: string;
  /** Split or recurring stream total alias. */
  total_amount?: string;
  /** Recurring stream per-cycle amount (used with `total_cycles`). */
  amount_per_cycle?: string;
  /** Recurring stream total cycle count (used with `amount_per_cycle`). */
  total_cycles?: number | string;
}

export interface IndexerRow {
  id: string;
  /** Stream kind; defaults to `"standard"` when omitted. */
  kind?: StreamKind | string;
  amount: string;
  status: string;
  ledgerSeq: number;
  /** Split stream total alias (normalised against `total_amount` / `amount`). */
  total?: string;
  /** Split or recurring stream total alias. */
  total_amount?: string;
  /** Recurring stream per-cycle amount (used with `total_cycles`). */
  amount_per_cycle?: string;
  /** Recurring stream total cycle count (used with `amount_per_cycle`). */
  total_cycles?: number | string;
}

export async function fetchAllDBRows(_sinceISO: string, _pageSize: number): Promise<DBRow[]> {
  return [];
}

export async function fetchAllIndexerRows(_sinceISO: string, _pageSize: number): Promise<IndexerRow[]> {
  return [];
}

export interface KindReconciliationSummary {
  totalDBRows: number;
  totalIndexerRows: number;
  missingInIndexerCount: number;
  missingInDBCount: number;
  mismatchedAmountCount: number;
  mismatchedStatusCount: number;
}

export interface ReconciliationDiff {
  missingInIndexer: Array<{ id: string; kind?: string; amount: string; createdAt: string }>;
  missingInDB: Array<{ id: string; kind?: string; amount: string; ledgerSeq: number }>;
  mismatchedAmount: Array<{ id: string; kind?: string; dbAmount: string; indexerAmount: string }>;
  mismatchedStatus: Array<{ id: string; kind?: string; dbStatus: string; indexerStatus: string }>;
}

export interface ReconciliationSummary {
  totalDBRows: number;
  totalIndexerRows: number;
  missingInIndexerCount: number;
  missingInDBCount: number;
  mismatchedAmountCount: number;
  mismatchedStatusCount: number;
  /** Per-kind breakdown; populated whenever any non-standard kind is present. */
  byKind?: Record<string, KindReconciliationSummary>;
}

/**
 * Resolve a row's stream kind, defaulting omitted/empty values to `"standard"`.
 * Unknown kinds from the indexer are preserved as-is so they are never silently
 * merged into `"standard"`.
 */
export function normalizeKind(kind?: string): StreamKind | string {
  if (!kind) return "standard";
  return kind;
}

type AmountSource = Pick<
  DBRow,
  "kind" | "amount" | "total" | "total_amount" | "amount_per_cycle" | "total_cycles"
>;

/**
 * Normalise a row's comparable total amount as a canonical base-10 bigint string.
 *
 * - `standard` (and unknown kinds): `BigInt(row.amount).toString()`
 * - `split`: prefers `total` or `total_amount` over `amount`, parsed with `BigInt`
 * - `recurring`: when `amount_per_cycle` and `total_cycles` are provided, computes
 *   `BigInt(amount_per_cycle) * BigInt(total_cycles)` without precision loss;
 *   otherwise falls back to `total_amount ?? amount`.
 */
export function normalizeAmountForKind(row: AmountSource): string {
  const kind = normalizeKind(row.kind);

  if (kind === "split") {
    const raw = row.total ?? row.total_amount ?? row.amount;
    return parseBigIntString(raw);
  }

  if (kind === "recurring") {
    if (row.amount_per_cycle !== undefined && row.total_cycles !== undefined) {
      return (BigInt(row.amount_per_cycle) * BigInt(row.total_cycles)).toString();
    }
    const raw = row.total_amount ?? row.amount;
    return parseBigIntString(raw);
  }

  return parseBigIntString(row.amount);
}

function parseBigIntString(value: string): string {
  try {
    return BigInt(value).toString();
  } catch {
    return value;
  }
}

function rowKey(kind: string, id: string): string {
  return `${kind}\0${id}`;
}

function emptyKindSummary(): KindReconciliationSummary {
  return {
    totalDBRows: 0,
    totalIndexerRows: 0,
    missingInIndexerCount: 0,
    missingInDBCount: 0,
    mismatchedAmountCount: 0,
    mismatchedStatusCount: 0,
  };
}

export function diffRows(
  db: DBRow[],
  indexer: IndexerRow[],
): { diff: ReconciliationDiff; summary: ReconciliationSummary } {
  const hasNonStandard =
    db.some((r) => normalizeKind(r.kind) !== "standard") ||
    indexer.some((r) => normalizeKind(r.kind) !== "standard");

  const dbByKey = new Map<string, { kind: string; row: DBRow }>();
  const idxByKey = new Map<string, { kind: string; row: IndexerRow }>();
  const byKind: Record<string, KindReconciliationSummary> = {};

  const ensureKind = (kind: string): KindReconciliationSummary => {
    if (!byKind[kind]) byKind[kind] = emptyKindSummary();
    return byKind[kind];
  };

  for (const row of db) {
    const kind = normalizeKind(row.kind);
    dbByKey.set(rowKey(kind, row.id), { kind, row });
    if (hasNonStandard) ensureKind(kind).totalDBRows++;
  }

  for (const row of indexer) {
    const kind = normalizeKind(row.kind);
    idxByKey.set(rowKey(kind, row.id), { kind, row });
    if (hasNonStandard) ensureKind(kind).totalIndexerRows++;
  }

  const missingInIndexer: ReconciliationDiff["missingInIndexer"] = [];
  const missingInDB: ReconciliationDiff["missingInDB"] = [];
  const mismatchedAmount: ReconciliationDiff["mismatchedAmount"] = [];
  const mismatchedStatus: ReconciliationDiff["mismatchedStatus"] = [];

  for (const [key, { kind, row: d }] of dbByKey) {
    const idxEntry = idxByKey.get(key);
    const dbAmount = normalizeAmountForKind(d);
    if (!idxEntry) {
      missingInIndexer.push(
        hasNonStandard
          ? { id: d.id, kind, amount: dbAmount, createdAt: d.createdAt }
          : { id: d.id, amount: dbAmount, createdAt: d.createdAt },
      );
      if (hasNonStandard) ensureKind(kind).missingInIndexerCount++;
      continue;
    }
    const i = idxEntry.row;
    const indexerAmount = normalizeAmountForKind(i);
    if (dbAmount !== indexerAmount) {
      mismatchedAmount.push(
        hasNonStandard
          ? { id: d.id, kind, dbAmount, indexerAmount }
          : { id: d.id, dbAmount, indexerAmount },
      );
      if (hasNonStandard) ensureKind(kind).mismatchedAmountCount++;
    }
    if (d.status !== i.status) {
      mismatchedStatus.push(
        hasNonStandard
          ? { id: d.id, kind, dbStatus: d.status, indexerStatus: i.status }
          : { id: d.id, dbStatus: d.status, indexerStatus: i.status },
      );
      if (hasNonStandard) ensureKind(kind).mismatchedStatusCount++;
    }
  }

  for (const [key, { kind, row: i }] of idxByKey) {
    if (!dbByKey.has(key)) {
      const indexerAmount = normalizeAmountForKind(i);
      missingInDB.push(
        hasNonStandard
          ? { id: i.id, kind, amount: indexerAmount, ledgerSeq: i.ledgerSeq }
          : { id: i.id, amount: indexerAmount, ledgerSeq: i.ledgerSeq },
      );
      if (hasNonStandard) ensureKind(kind).missingInDBCount++;
    }
  }

  const summary: ReconciliationSummary = {
    totalDBRows: db.length,
    totalIndexerRows: indexer.length,
    missingInIndexerCount: missingInIndexer.length,
    missingInDBCount: missingInDB.length,
    mismatchedAmountCount: mismatchedAmount.length,
    mismatchedStatusCount: mismatchedStatus.length,
    ...(hasNonStandard ? { byKind } : {}),
  };

  return {
    diff: { missingInIndexer, missingInDB, mismatchedAmount, mismatchedStatus },
    summary,
  };
}