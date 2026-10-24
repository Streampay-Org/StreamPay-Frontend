import { createHmac, randomUUID } from "crypto";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { attachRequestFingerprintMetadata } from "@/lib/fingerprint";
import type {
  AuditActor,
  AuditActorRole,
  AuditEntry,
  AuditEntryInput,
  AuditExportRow,
  AuditListFilters,
  AuditMetadataValue,
  AuditPurgeResult,
  AuditCheckpoint,
} from "@/app/types/audit";
import type { DeepArchiveEntry, DeepArchiveResult } from "@/app/types/audit";
export type { DeepArchiveEntry, DeepArchiveResult, AuditCheckpoint };

export const AUDIT_LOG_RETENTION_DAYS = 30;

const VALID_ROLES = new Set<AuditActorRole>([
  "user",
  "support",
  "admin",
  "finance",
  "security",
  "compliance",
  "system",
]);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        const nestedValue = (value as Record<string, unknown>)[key];
        if (nestedValue !== undefined) {
          accumulator[key] = sortKeys(nestedValue);
        }
        return accumulator;
      }, {});
  }

  return value;
}

/**
 * Fixed test key used in dev/test when AUDIT_CHAIN_KEY is not set.
 * Never used in production — validateConfig() throws if missing.
 */
const TEST_AUDIT_CHAIN_KEY = "test-audit-chain-key-do-not-use-in-prod";

function getAuditChainKey(): string {
  const key = process.env.AUDIT_CHAIN_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUDIT_CHAIN_KEY is required in production");
  }
  // Dev/test fallback
  return TEST_AUDIT_CHAIN_KEY;
}

function hashValue(value: unknown): string {
  const key = getAuditChainKey();
  return createHmac("sha256", key).update(JSON.stringify(sortKeys(value))).digest("hex");
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function addRetention(timestamp: string): string {
  const retentionDate = new Date(timestamp);
  retentionDate.setUTCDate(retentionDate.getUTCDate() + AUDIT_LOG_RETENTION_DAYS);
  return retentionDate.toISOString();
}

function redactTargetAccount(account: string | undefined): string | null {
  if (!account) {
    return null;
  }
  if (account.length <= 8) {
    return `${account.slice(0, 2)}***${account.slice(-2,)}`;
  }
  return `${account.slice(0, 4)}***${account.slice(-4)}`;
}

export class AppendOnlyAuditLogStore {
  private readonly entries: AuditEntry[] = [];
  private readonly archivedEntries: AuditEntry[] = [];
  private readonly deepArchivedEntries: DeepArchiveEntry[] = [];
  private readonly checkpoints: AuditCheckpoint[] = [];

  append(input: AuditEntryInput): AuditEntry {
    const lastEntry = this.entries[this.entries.length - 1];
    const timestamp = input.timestamp ?? new Date().toISOString();
    const beforeHash = input.before ? hashValue(input.before) : null;
    const afterHash = input.after ? hashValue(input.after) : null;
    const diffHash =
      input.diffHash ??
      (beforeHash || afterHash
        ? hashValue({
            afterHash,
            beforeHash,
          })
        : null);
    const prevHash = lastEntry?.entryHash ?? null;
    const entryHash = hashValue({
      action: input.action,
      actor: input.actor,
      afterHash,
      beforeHash,
      diffHash,
      metadata: input.metadata ?? null,
      prevHash,
      requestId: input.requestId,
      target: input.target,
      timestamp,
    });

    const entry = deepFreeze({
      action: input.action,
      actor: cloneValue(input.actor),
      afterHash,
      beforeHash,
      diffHash,
      entryHash,
      id: `audit-${randomUUID()}`,
      metadata: input.metadata ? cloneValue(input.metadata) : undefined,
      prevHash,
      requestId: input.requestId,
      retentionUntil: addRetention(timestamp),
      target: cloneValue(input.target),
      timestamp,
    } satisfies AuditEntry);

    this.entries.push(entry);
    return cloneValue(entry);
  }

  list(filters: AuditListFilters = {}): AuditEntry[] {
    return this.getPaginated(filters).data;
  }

  getPaginated(filters: AuditListFilters = {}): { data: AuditEntry[]; hasNext: boolean; nextCursor: string | null; total: number } {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 250);

    let results = this.entries.filter((entry) => {
      if (filters.actorId && entry.actor.id !== filters.actorId) return false;
      if (filters.role && entry.actor.role !== filters.role) return false;
      if (filters.action && entry.action !== filters.action) return false;
      if (filters.targetId && entry.target.id !== filters.targetId) return false;
      if (filters.requestId && entry.requestId !== filters.requestId) return false;
      if (filters.orgId && entry.metadata?.orgId !== filters.orgId) return false;
      if (filters.startDate && entry.timestamp < filters.startDate) return false;
      if (filters.endDate && entry.timestamp > filters.endDate) return false;
      if (filters.q) {
        const haystack = [
          entry.actor.id,
          entry.actor.role,
          entry.action,
          entry.target.id,
          entry.target.account ?? "",
          entry.requestId,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(filters.q.toLowerCase())) return false;
      }
      return true;
    });

    const total = results.length;

    results = results.sort((left, right) => {
      const tsCmp = right.timestamp.localeCompare(left.timestamp);
      return tsCmp !== 0 ? tsCmp : right.id.localeCompare(left.id);
    });

    if (filters.cursor) {
      // Decode composite cursor
      let cursorTimestamp = "";
      let cursorId = "";
      try {
        const decoded = Buffer.from(filters.cursor, "base64").toString("utf-8");
        const parts = decoded.split("|");
        if (parts.length === 2) {
          cursorTimestamp = parts[0];
          cursorId = parts[1];
        }
      } catch {
        // Invalid cursor format handled by returning no results or ignoring?
        // We'll throw an error and let the caller handle it or just return empty
      }

      if (cursorTimestamp && cursorId) {
        const cursorIndex = results.findIndex((entry) => {
          const tsCmp = entry.timestamp.localeCompare(cursorTimestamp);
          return tsCmp < 0 || (tsCmp === 0 && entry.id.localeCompare(cursorId) <= 0);
        });
        if (cursorIndex >= 0) {
          // Because we sort descending, we want items after the cursor
          // Actually, if the cursor is an item, we want to start from the item AFTER it in the sorted array
          // The cursorIndex points to an item that is <= cursor in sorting.
          // Since it's exactly the cursor, we skip it.
          const exactIndex = results.findIndex(e => e.id === cursorId);
          if (exactIndex >= 0) {
             results = results.slice(exactIndex + 1);
          } else {
             results = results.filter((entry) => {
               const tsCmp = entry.timestamp.localeCompare(cursorTimestamp);
               // Because it's descending, we want entries that are OLDER (smaller timestamp)
               // or SAME timestamp but smaller ID.
               if (tsCmp !== 0) return tsCmp < 0; // older
               return entry.id.localeCompare(cursorId) < 0; // smaller id
             });
          }
        }
      }
    }

    const hasNext = results.length > limit;
    const paginatedResults = results.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasNext && paginatedResults.length > 0) {
      const lastEntry = paginatedResults[paginatedResults.length - 1];
      nextCursor = Buffer.from(`${lastEntry.timestamp}|${lastEntry.id}`).toString("base64");
    }

    return {
      data: paginatedResults.map((entry) => cloneValue(entry)),
      hasNext,
      nextCursor,
      total,
    };
  }

  exportRows(filters: AuditListFilters = {}): AuditExportRow[] {
    return this.getPaginated({ ...filters, limit: Number.MAX_SAFE_INTEGER }).data
      .map((entry) => this.toExportRow(entry));
  }

  /**
   * Export rows for archived entries (soft-archived by retention plus
   * deep-archived cold-storage entries). Uses the same redacted projection as
   * `exportRows` so archived downloads never leak unredacted target accounts.
   *
   * Rows are ordered newest-first and capped by `limit` (1–250, default 250)
   * for deterministic, bounded output.
   */
  exportArchivedRows(limit = 250): AuditExportRow[] {
    const rows: AuditExportRow[] = [];
    for (const entry of this.archivedEntries) {
      rows.push(this.toExportRow(entry));
    }
    for (const deepEntry of this.deepArchivedEntries) {
      rows.push(this.toExportRow(deepEntry.entry));
    }
    const capped = Math.min(Math.max(limit, 1), 250);
    return rows
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, capped);
  }

  archiveExpiredEntries(referenceTimestamp: string | Date = new Date().toISOString()): AuditEntry[] {
    const cutoff = new Date(referenceTimestamp).getTime();
    const expiredEntries = this.entries.filter((entry) => new Date(entry.retentionUntil).getTime() <= cutoff);

    if (expiredEntries.length === 0) {
      return [];
    }

    const remainingEntries = this.entries.filter((entry) => new Date(entry.retentionUntil).getTime() > cutoff);

    this.entries.splice(0, this.entries.length, ...remainingEntries);
    this.archivedEntries.push(...expiredEntries.map((entry) => deepFreeze(cloneValue(entry))));

    return expiredEntries.map((entry) => cloneValue(entry));
  }

  restoreArchivedEntries(): AuditEntry[] {
    if (this.archivedEntries.length === 0) {
      return [];
    }

    const restored = this.archivedEntries.splice(0, this.archivedEntries.length).map((entry) => cloneValue(entry));
    this.entries.splice(0, 0, ...restored);
    return restored;
  }

  getArchivedEntries(): AuditEntry[] {
    return this.archivedEntries.map((entry) => cloneValue(entry));
  }

  count(): number {
    return this.entries.length;
  }

  assertIntegrity(): boolean {
    const chain = [...this.archivedEntries, ...this.entries];
    if (chain.length === 0) return true;

    // The first entry's prevHash must be null (genesis) or match a checkpoint's
    // lastPurgedHash (the chain was truncated at a checkpoint).
    const firstPrev = chain[0].prevHash;
    const validGenesis = firstPrev === null;
    const validCheckpoint = this.checkpoints.some(
      (cp) => cp.lastPurgedHash === firstPrev,
    );
    if (!validGenesis && !validCheckpoint) return false;

    let previousHash: string | null = chain[0].prevHash;

    for (const entry of chain) {
      const recalculatedHash = hashValue({
        action: entry.action,
        actor: entry.actor,
        afterHash: entry.afterHash,
        beforeHash: entry.beforeHash,
        diffHash: entry.diffHash,
        metadata: entry.metadata ?? null,
        prevHash: entry.prevHash,
        requestId: entry.requestId,
        target: entry.target,
        timestamp: entry.timestamp,
      });

      if (entry.prevHash !== previousHash) {
        return false;
      }

      if (entry.entryHash !== recalculatedHash) {
        return false;
      }

      previousHash = entry.entryHash;
    }

    return true;
  }

  updateEntry(_id: string, _changes: Partial<AuditEntry>) {
    throw new Error("AUDIT_LOG_APPEND_ONLY");
  }

  deleteEntry(_id: string) {
    throw new Error("AUDIT_LOG_APPEND_ONLY");
  }

  purgeArchivedRows(cutoffTimestamp: string, execute = false): AuditPurgeResult {
    const cutoffMs = Date.parse(cutoffTimestamp);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error("INVALID_PURGE_CUTOFF");
    }

    const chainIntactBefore = this.assertIntegrity();
    const purged = this.entries.filter((entry) => Date.parse(entry.timestamp) < cutoffMs);
    const retained = this.entries.filter((entry) => Date.parse(entry.timestamp) >= cutoffMs);

    if (!execute) {
      // Dry run: no checkpoint, no mutation
      return {
        chainIntactAfter: chainIntactBefore,
        chainIntactBefore,
        cutoffTimestamp: new Date(cutoffMs).toISOString(),
        executed: false,
        purgedEntries: purged.length,
        purgedIds: purged.map((entry) => entry.id),
        retainedEntries: retained.length,
        checkpointId: null,
      };
    }

    if (purged.length === 0) {
      return {
        chainIntactAfter: chainIntactBefore,
        chainIntactBefore,
        cutoffTimestamp: new Date(cutoffMs).toISOString(),
        executed: true,
        purgedEntries: 0,
        purgedIds: [],
        retainedEntries: retained.length,
        checkpointId: null,
      };
    }

    // Create a checkpoint recording what was removed
    const lastPurged = purged[purged.length - 1];
    const checkpointId = `audit-checkpoint-${randomUUID()}`;
    const checkpoint: AuditCheckpoint = {
      checkpointId,
      purgedCount: purged.length,
      firstPurgedId: purged[0].id,
      lastPurgedId: lastPurged.id,
      lastPurgedHash: lastPurged.entryHash,
      cutoff: new Date(cutoffMs).toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.checkpoints.push(checkpoint);

    // Retained entries keep their original prevHash — no rebasing.
    this.entries.splice(0, this.entries.length, ...retained);

    return {
      chainIntactAfter: this.assertIntegrity(),
      chainIntactBefore,
      cutoffTimestamp: new Date(cutoffMs).toISOString(),
      executed: true,
      purgedEntries: purged.length,
      purgedIds: purged.map((entry) => entry.id),
      retainedEntries: retained.length,
      checkpointId,
    };
  }

  deepArchive(cutoffTimestamp: string, execute = false): DeepArchiveResult {
    const cutoffMs = Date.parse(cutoffTimestamp);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error("INVALID_PURGE_CUTOFF");
    }

    const candidates = this.archivedEntries.filter((entry) => Date.parse(entry.timestamp) < cutoffMs);
    const retained = this.archivedEntries.filter((entry) => Date.parse(entry.timestamp) >= cutoffMs);

    if (execute && candidates.length > 0) {
      this.archivedEntries.splice(0, this.archivedEntries.length, ...retained);
      this.deepArchivedEntries.push(
        ...candidates.map((entry) => ({
          entry: deepFreeze(cloneValue(entry)),
          archivedAt: new Date().toISOString(),
        })),
      );
    }

    return {
      archivedEntries: candidates.length,
      archivedIds: candidates.map((entry) => entry.id),
      cutoffTimestamp: new Date(cutoffMs).toISOString(),
      executed: execute,
      retainedEntries: retained.length,
    };
  }

  getDeepArchivedEntries(): DeepArchiveEntry[] {
    return this.deepArchivedEntries.map((de) => ({
      entry: cloneValue(de.entry),
      archivedAt: de.archivedAt,
    }));
  }

  reset(seedEntries: AuditEntryInput[] = defaultSeedAuditEntries) {
    this.entries.splice(0, this.entries.length);
    this.archivedEntries.splice(0, this.archivedEntries.length);
    this.deepArchivedEntries.splice(0, this.deepArchivedEntries.length);
    this.checkpoints.splice(0, this.checkpoints.length);
    for (const entry of seedEntries) {
      this.append(entry);
    }
  }

  private rebaseChain(entries: AuditEntry[]): AuditEntry[] {
    let prevHash: string | null = null;
    return entries.map((entry) => {
      const next = { ...entry, prevHash } as AuditEntry;
      const entryHash = hashValue({
        action: next.action,
        actor: next.actor,
        afterHash: next.afterHash,
        beforeHash: next.beforeHash,
        diffHash: next.diffHash,
        metadata: next.metadata ?? null,
        prevHash: next.prevHash,
        requestId: next.requestId,
        target: next.target,
        timestamp: next.timestamp,
      });
      prevHash = entryHash;
      return deepFreeze({ ...next, entryHash });
    });
  }

  private toExportRow(entry: AuditEntry): AuditExportRow {
    return {
      action: entry.action,
      actorId: entry.actor.id,
      actorRole: entry.actor.role,
      afterHash: entry.afterHash,
      beforeHash: entry.beforeHash,
      diffHash: entry.diffHash,
      entryHash: entry.entryHash,
      id: entry.id,
      metadata: entry.metadata,
      prevHash: entry.prevHash,
      redactedTargetAccount: redactTargetAccount(entry.target.account),
      redactionPolicy: "mask-target-account",
      requestId: entry.requestId,
      retentionUntil: entry.retentionUntil,
      targetId: entry.target.id,
      targetType: entry.target.type,
      timestamp: entry.timestamp,
    };
  }
}

export const auditLogStore = new AppendOnlyAuditLogStore();

export interface PrivilegedStreamAuditEventInput {
  action: string;
  streamId?: string;
  tenantId?: string;
  actor?: AuditActor | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, AuditMetadataValue>;
  target?: { id?: string; type?: string; account?: string };
  requestId?: string;
}

export function recordPrivilegedStreamAuditEvent(input: PrivilegedStreamAuditEventInput): AuditEntry {
  const actorId = input.actor?.id ?? "system";
  const role = ((input.actor?.role as AuditActorRole | undefined) ?? "system");
  const targetId = input.target?.id ?? input.streamId ?? "unknown";
  const targetType = input.target?.type ?? "stream";
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  } as Record<string, AuditMetadataValue>;

  return auditLogStore.append({
    action: input.action,
    actor: {
      id: actorId,
      role: VALID_ROLES.has(role) ? role : "system",
      account: input.actor?.account,
    },
    after: input.after as any,
    before: input.before as any,
    metadata,
    requestId: input.requestId ?? "",
    target: {
      id: targetId,
      type: targetType,
      account: input.target?.account,
    },
  });
}