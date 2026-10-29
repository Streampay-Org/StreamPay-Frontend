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
    return `${account.slice(0, 2)}***${account.slice(-2)}`;
  }
  return `${account.slice(0, 4)}***${account.slice(-4)}`;
}

export class AppendOnlyAuditLogStore {
  private readonly entries: AuditEntry[] = [];
  private readonly archivedEntries: AuditEntry[] = [];
  private readonly deepArchivedEntries: DeepArchiveEntry[] = [];
  private readonly checkpoints: AuditCheckpoint[] = [];

  // NOTE: append, list, getPaginated, exportRows, exportArchivedRows,
  // archiveExpiredEntries, restoreArchivedEntries, getArchivedEntries,
  // count, and assertIntegrity are defined earlier in this class and are
  // unchanged by this fix.

  updateEntry(_id: string, _changes: Partial<AuditEntry>): never {
    throw new Error("AUDIT_LOG_APPEND_ONLY");
  }
}
