
export type StreamKind = 'standard' | 'split' | 'recurring';

export interface DbStream {
  id: string;
  /** Stream kind; defaults to `'standard'` when omitted. */
  kind?: StreamKind;
  recipient_address: string;
  total_amount: string; // Stored as string in DB to avoid precision loss
  released_amount: string;
  status: string;
  last_sync_ledger: number;
  /** Split stream total alias (normalised against `total_amount`). */
  total?: string;
  /** Recurring stream per-cycle amount (used with `total_cycles`). */
  amount_per_cycle?: string;
  /** Recurring stream total cycle count (used with `amount_per_cycle`). */
  total_cycles?: number | string;
}

export interface ReconciliationDiff {
  streamId: string;
  kind?: StreamKind;
  field: string;
  dbValue: string | bigint | number;
  onChainValue: string | bigint | number;
  toleranceApplied: boolean;
}

export interface KindReportSummary {
  totalStreamsChecked: number;
  mismatchCount: number;
  errorCount: number;
}

export interface ReconciliationReport {
  timestamp: string;
  totalStreamsChecked: number;
  mismatches: ReconciliationDiff[];
  errors: { streamId: string; kind?: StreamKind; error: string }[];
  status: 'SUCCESS' | 'MISMATCH_FOUND' | 'FAILED';
  /** Per-kind breakdown; populated whenever any non-standard kind is checked. */
  byKind?: Partial<Record<StreamKind, KindReportSummary>>;
}
