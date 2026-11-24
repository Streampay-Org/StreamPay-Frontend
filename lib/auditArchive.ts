import {
  auditLogStore,
  type AppendOnlyAuditLogStore,
  type DeepArchiveEntry,
  type DeepArchiveResult,
} from "@/app/lib/audit-log";

export const DEEP_ARCHIVE_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function computeCutoff(referenceTimestamp: string): string {
  const referenceMs = Date.parse(referenceTimestamp);
  if (!Number.isFinite(referenceMs)) {
    throw new Error("INVALID_REFERENCE_TIMESTAMP");
  }
  return new Date(referenceMs - DEEP_ARCHIVE_DAYS * MS_PER_DAY).toISOString();
}

export function deepArchiveExpiredEntries(
  store: AppendOnlyAuditLogStore = auditLogStore,
  referenceTimestamp: string = new Date().toISOString(),
): DeepArchiveResult {
  const cutoffTimestamp = computeCutoff(referenceTimestamp);
  return store.deepArchive(cutoffTimestamp);
}

export function getDeepArchivedEntries(
  store: AppendOnlyAuditLogStore = auditLogStore,
): DeepArchiveEntry[] {
  return store.getDeepArchivedEntries();
}
