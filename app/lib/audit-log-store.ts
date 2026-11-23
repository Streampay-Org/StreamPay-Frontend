import type {
  AuditCheckpoint,
  AuditEntry,
  AuditEntryInput,
  AuditExportRow,
  AuditListFilters,
  AuditPurgeResult,
  DeepArchiveEntry,
  DeepArchiveResult,
} from "@/app/types/audit";

export type AuditLogStoreMode = "memory" | "postgres";

export interface AuditPaginatedResult {
  data: AuditEntry[];
  hasNext: boolean;
  nextCursor: string | null;
  total: number;
}

/**
 * Storage-agnostic contract for the append-only audit log.
 *
 * Methods may return synchronously (in-memory store) or asynchronously
 * (Postgres-backed store) so existing synchronous callers and tests continue
 * to work unchanged while async stores satisfy the same interface.
 */
export interface AuditLogStore {
  append(input: AuditEntryInput): AuditEntry | Promise<AuditEntry>;
  list(filters?: AuditListFilters): AuditEntry[] | Promise<AuditEntry[]>;
  getPaginated(
    filters?: AuditListFilters,
  ): AuditPaginatedResult | Promise<AuditPaginatedResult>;
  exportRows(filters?: AuditListFilters): AuditExportRow[] | Promise<AuditExportRow[]>;
  exportArchivedRows(limit?: number): AuditExportRow[] | Promise<AuditExportRow[]>;
  archiveExpiredEntries(
    referenceTimestamp?: string | Date,
  ): AuditEntry[] | Promise<AuditEntry[]>;
  restoreArchivedEntries(): AuditEntry[] | Promise<AuditEntry[]>;
  getArchivedEntries(): AuditEntry[] | Promise<AuditEntry[]>;
  count(): number | Promise<number>;
  assertIntegrity(): boolean | Promise<boolean>;
  updateEntry(id: string, changes: Partial<AuditEntry>): never | Promise<never>;
  deleteEntry(id: string): never | Promise<never>;
  purgeArchivedRows(
    cutoffTimestamp: string,
    execute?: boolean,
  ): AuditPurgeResult | Promise<AuditPurgeResult>;
  deepArchive(cutoffTimestamp: string): DeepArchiveResult | Promise<DeepArchiveResult>;
  getDeepArchivedEntries(): DeepArchiveEntry[] | Promise<DeepArchiveEntry[]>;
  reset(seedEntries?: AuditEntryInput[]): void | Promise<void>;
  getCheckpoints(): AuditCheckpoint[] | Promise<AuditCheckpoint[]>;
}
