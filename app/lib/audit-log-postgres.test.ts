/** @jest-environment node */

jest.mock("@/app/lib/auth", () => ({
  tryAuthenticateRequest: jest.fn().mockReturnValue(null),
}));
jest.mock("@/lib/fingerprint", () => ({
  attachRequestFingerprintMetadata: jest.fn((_req: unknown, meta: unknown) => meta),
  REQUEST_FINGERPRINT_HEADER: "x-request-fingerprint",
}));
jest.mock("@/lib/fingerprint-audit", () => ({}));

import { AppendOnlyAuditLogStore } from "./audit-log";
import type { AuditLogStore } from "./audit-log-store";
import {
  PostgresAuditLogStore,
  type SqlClient,
  type SqlExecutor,
} from "./audit-log-postgres";
import {
  ConfigValidationError,
  resetConfigCache,
  validateConfig,
} from "./config";
import type { AuditEntryInput } from "@/app/types/audit";

interface FakeAuditEntryRow {
  id: string;
  seq: number;
  ts: string;
  ts_iso: string;
  actor_id: string;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  target_account: string | null;
  before_hash: string | null;
  after_hash: string | null;
  diff_hash: string | null;
  metadata: Record<string, unknown> | null;
  request_id: string;
  prev_hash: string | null;
  hash: string;
  retention_until: string;
  retention_until_iso: string;
  archived_at: string | null;
  deep_archived: boolean;
  deep_archived_at: string | null;
}

interface FakeCheckpointRow {
  checkpoint_id: string;
  purged_count: number;
  first_purged_id: string;
  last_purged_id: string;
  last_purged_hash: string;
  cutoff: string;
  created_at: string;
}

/**
 * In-memory Postgres emulator for unit and contract tests.
 * Supports transactions, advisory locks, parameterised queries, and
 * direct row tampering for integrity verification tests.
 */
class FakePostgresExecutor implements SqlExecutor {
  public entries: FakeAuditEntryRow[] = [];
  public checkpoints: FakeCheckpointRow[] = [];
  public executedQueries: Array<{ sql: string; params?: readonly unknown[] }> = [];
  private nextSeq = 1;
  private lockQueue: Promise<void> = Promise.resolve();

  tamperEntry(id: string, patch: Partial<FakeAuditEntryRow>): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      throw new Error(`Entry ${id} not found`);
    }
    this.entries[idx] = { ...this.entries[idx], ...patch };
  }

  async connect(): Promise<SqlClient> {
    let releaseLock: (() => void) | null = null;

    const client: SqlClient = {
      query: async <TResult = unknown>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<{ rows: TResult[] }> => {
        const trimmed = sql.trim();

        if (trimmed.startsWith("SELECT pg_advisory_xact_lock")) {
          this.executedQueries.push({ sql, params });
          const prev = this.lockQueue;
          let nextResolve!: () => void;
          this.lockQueue = new Promise<void>((resolve) => {
            nextResolve = resolve;
          });
          await prev;
          releaseLock = nextResolve;
          return { rows: [] };
        }

        if (trimmed === "COMMIT" || trimmed === "ROLLBACK") {
          this.executedQueries.push({ sql, params });
          if (releaseLock) {
            const fn = releaseLock;
            releaseLock = null;
            fn();
          }
          return { rows: [] };
        }

        return this.query<TResult>(sql, params);
      },
      release: () => {
        if (releaseLock) {
          const fn = releaseLock;
          releaseLock = null;
          fn();
        }
      },
    };

    return client;
  }

  async query<TResult = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: TResult[] }> {
    this.executedQueries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (
      normalized === "BEGIN" ||
      normalized === "COMMIT" ||
      normalized === "ROLLBACK" ||
      normalized.startsWith("SELECT set_config") ||
      normalized.startsWith("SELECT pg_advisory_xact_lock")
    ) {
      return { rows: [] };
    }

    // Last hash for append
    if (
      normalized.startsWith(
        "SELECT hash FROM audit_entries WHERE deep_archived = FALSE ORDER BY seq DESC LIMIT 1",
      )
    ) {
      const active = this.entries
        .filter((e) => !e.deep_archived)
        .sort((a, b) => b.seq - a.seq);
      return {
        rows: (active[0] ? [{ hash: active[0].hash }] : []) as TResult[],
      };
    }

    // INSERT INTO audit_entries
    if (normalized.startsWith("INSERT INTO audit_entries")) {
      const row: FakeAuditEntryRow = {
        id: String(params[0]),
        seq: this.nextSeq++,
        ts: String(params[1]),
        ts_iso: String(params[2]),
        actor_id: String(params[3]),
        actor_role: String(params[4]),
        action: String(params[5]),
        target_type: String(params[6]),
        target_id: String(params[7]),
        target_account: params[8] === null ? null : String(params[8]),
        before_hash: params[9] === null ? null : String(params[9]),
        after_hash: params[10] === null ? null : String(params[10]),
        diff_hash: params[11] === null ? null : String(params[11]),
        metadata:
          params[12] === null
            ? null
            : (JSON.parse(String(params[12])) as Record<string, unknown>),
        request_id: String(params[13]),
        prev_hash: params[14] === null ? null : String(params[14]),
        hash: String(params[15]),
        retention_until: String(params[16]),
        retention_until_iso: String(params[17]),
        archived_at: null,
        deep_archived: false,
        deep_archived_at: null,
      };
      this.entries.push(row);
      return { rows: [{ ...row }] as TResult[] };
    }

    // INSERT INTO audit_checkpoints
    if (normalized.startsWith("INSERT INTO audit_checkpoints")) {
      const cp: FakeCheckpointRow = {
        checkpoint_id: String(params[0]),
        purged_count: Number(params[1]),
        first_purged_id: String(params[2]),
        last_purged_id: String(params[3]),
        last_purged_hash: String(params[4]),
        cutoff: String(params[5]),
        created_at: String(params[6]),
      };
      this.checkpoints.push(cp);
      return { rows: [] };
    }

    // SELECT checkpoints
    if (normalized.includes("FROM audit_checkpoints")) {
      const sorted = [...this.checkpoints].sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
      return { rows: sorted as TResult[] };
    }

    // DELETE all (reset)
    if (normalized === "DELETE FROM audit_entries") {
      this.entries = [];
      return { rows: [] };
    }
    if (normalized === "DELETE FROM audit_checkpoints") {
      this.checkpoints = [];
      return { rows: [] };
    }

    // DELETE purge
    if (normalized.startsWith("DELETE FROM audit_entries WHERE archived_at IS NULL AND deep_archived = FALSE AND ts < $1")) {
      const cutoffMs = Date.parse(String(params[0]));
      this.entries = this.entries.filter(
        (e) =>
          !(
            e.archived_at === null &&
            !e.deep_archived &&
            Date.parse(e.ts) < cutoffMs
          ),
      );
      return { rows: [] };
    }

    // UPDATE archiveExpiredEntries
    if (normalized.startsWith("UPDATE audit_entries SET archived_at = $1")) {
      const archivedAt = String(params[0]);
      const cutoffMs = Date.parse(String(params[1]));
      const updated: FakeAuditEntryRow[] = [];
      for (const e of this.entries) {
        if (
          e.archived_at === null &&
          !e.deep_archived &&
          Date.parse(e.retention_until) <= cutoffMs
        ) {
          e.archived_at = archivedAt;
          updated.push({ ...e });
        }
      }
      return { rows: updated as TResult[] };
    }

    // UPDATE restoreArchivedEntries
    if (normalized.startsWith("UPDATE audit_entries SET archived_at = NULL")) {
      const updated: FakeAuditEntryRow[] = [];
      for (const e of this.entries) {
        if (e.archived_at !== null && !e.deep_archived) {
          e.archived_at = null;
          updated.push({ ...e });
        }
      }
      return { rows: updated as TResult[] };
    }

    // UPDATE deepArchive
    if (normalized.startsWith("UPDATE audit_entries SET deep_archived = TRUE")) {
      const archivedAt = String(params[0]);
      const cutoffMs = Date.parse(String(params[1]));
      for (const e of this.entries) {
        if (!e.deep_archived && Date.parse(e.ts) < cutoffMs) {
          e.deep_archived = true;
          e.deep_archived_at = archivedAt;
        }
      }
      return { rows: [] };
    }

    // Integrity batch scan
    if (normalized.includes("WHERE deep_archived = FALSE AND seq > $1 ORDER BY seq ASC LIMIT $2")) {
      const lastSeq = Number(params[0]);
      const limit = Number(params[1]);
      const rows = this.entries
        .filter((e) => !e.deep_archived && e.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    // Export archived rows
    if (normalized.includes("WHERE archived_at IS NOT NULL OR deep_archived = TRUE ORDER BY ts_iso DESC LIMIT $1")) {
      const limit = Number(params[0]);
      const rows = this.entries
        .filter((e) => e.archived_at !== null || e.deep_archived)
        .sort((a, b) => b.ts_iso.localeCompare(a.ts_iso))
        .slice(0, limit)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    // getArchivedEntries
    if (normalized.includes("WHERE archived_at IS NOT NULL AND deep_archived = FALSE ORDER BY seq ASC")) {
      const rows = this.entries
        .filter((e) => e.archived_at !== null && !e.deep_archived)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    // getDeepArchivedEntries
    if (normalized.includes("WHERE deep_archived = TRUE ORDER BY seq ASC")) {
      const rows = this.entries
        .filter((e) => e.deep_archived)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    // deepArchive selection
    if (normalized.includes("WHERE deep_archived = FALSE AND ts < $1 ORDER BY seq ASC")) {
      const cutoffMs = Date.parse(String(params[0]));
      const rows = this.entries
        .filter((e) => !e.deep_archived && Date.parse(e.ts) < cutoffMs)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    // purge dry-run / selection
    if (normalized.includes("WHERE archived_at IS NULL AND deep_archived = FALSE AND ts < $1 ORDER BY seq ASC")) {
      const cutoffMs = Date.parse(String(params[0]));
      const rows = this.entries
        .filter((e) => e.archived_at === null && !e.deep_archived && Date.parse(e.ts) < cutoffMs)
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e }));
      return { rows: rows as TResult[] };
    }

    if (normalized.includes("WHERE archived_at IS NULL AND deep_archived = FALSE AND ts >= $1")) {
      const cutoffMs = Date.parse(String(params[0]));
      const total = this.entries.filter(
        (e) => e.archived_at === null && !e.deep_archived && Date.parse(e.ts) >= cutoffMs,
      ).length;
      return { rows: [{ total }] as TResult[] };
    }

    // Generic filtered COUNT or SELECT (getPaginated / count)
    if (normalized.includes("FROM audit_entries WHERE")) {
      const filtered = this.applyWhere(normalized, params);
      if (normalized.startsWith("SELECT COUNT(*)")) {
        return { rows: [{ total: filtered.length }] as TResult[] };
      }
      const limitMatch = normalized.match(/LIMIT \$(\d+)$/);
      const limit = limitMatch ? Number(params[Number(limitMatch[1]) - 1]) : filtered.length;
      const sorted = filtered
        .sort((a, b) => {
          const tsCmp = b.ts_iso.localeCompare(a.ts_iso);
          return tsCmp !== 0 ? tsCmp : b.id.localeCompare(a.id);
        })
        .slice(0, limit)
        .map((e) => ({ ...e }));
      return { rows: sorted as TResult[] };
    }

    throw new Error(`Unhandled SQL in FakePostgresExecutor: ${normalized}`);
  }

  private applyWhere(sql: string, params: readonly unknown[]): FakeAuditEntryRow[] {
    let rows = this.entries.filter(
      (e) => e.archived_at === null && !e.deep_archived,
    );

    const matchParam = (pattern: RegExp): unknown | undefined => {
      const m = sql.match(pattern);
      return m ? params[Number(m[1]) - 1] : undefined;
    };

    const actorId = matchParam(/actor_id = \$(\d+)/);
    if (actorId !== undefined) {
      rows = rows.filter((e) => e.actor_id === actorId);
    }

    const actorRole = matchParam(/actor_role = \$(\d+)/);
    if (actorRole !== undefined) {
      rows = rows.filter((e) => e.actor_role === actorRole);
    }

    const action = matchParam(/action = \$(\d+)/);
    if (action !== undefined) {
      rows = rows.filter((e) => e.action === action);
    }

    const targetId = matchParam(/target_id = \$(\d+)/);
    if (targetId !== undefined) {
      rows = rows.filter((e) => e.target_id === targetId);
    }

    const requestId = matchParam(/request_id = \$(\d+)/);
    if (requestId !== undefined) {
      rows = rows.filter((e) => e.request_id === requestId);
    }

    const orgId = matchParam(/metadata->>'orgId' = \$(\d+)/);
    if (orgId !== undefined) {
      rows = rows.filter((e) => e.metadata?.orgId === orgId);
    }

    const startDate = matchParam(/ts_iso >= \$(\d+)/);
    if (startDate !== undefined) {
      rows = rows.filter((e) => e.ts_iso >= String(startDate));
    }

    const endDate = matchParam(/ts_iso <= \$(\d+)/);
    if (endDate !== undefined) {
      rows = rows.filter((e) => e.ts_iso <= String(endDate));
    }

    const likeQ = matchParam(/LIKE \$(\d+)/);
    if (likeQ !== undefined) {
      const needle = String(likeQ).replace(/^%|%$/g, "").toLowerCase();
      rows = rows.filter((e) => {
        const haystack = [
          e.actor_id,
          e.actor_role,
          e.action,
          e.target_id,
          e.target_account ?? "",
          e.request_id,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });
    }

    const cursorMatch = sql.match(/\(ts_iso < \$(\d+) OR \(ts_iso = \$\1 AND id < \$(\d+)\)\)/);
    if (cursorMatch) {
      const cursorTs = String(params[Number(cursorMatch[1]) - 1]);
      const cursorId = String(params[Number(cursorMatch[2]) - 1]);
      rows = rows.filter((e) => {
        const tsCmp = e.ts_iso.localeCompare(cursorTs);
        if (tsCmp !== 0) return tsCmp < 0;
        return e.id.localeCompare(cursorId) < 0;
      });
    }

    return rows;
  }
}

function makeInput(id: string, timestamp: string, overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    action: "stream.settle",
    actor: { id: `actor-${id}`, role: "admin" },
    after: { status: "ended" },
    before: { status: "active" },
    requestId: `req-${id}`,
    target: { account: "acct_sensitive_target", id: `stream-${id}`, type: "stream" },
    timestamp,
    ...overrides,
  };
}

// ============================================================================
// Shared contract tests: identical semantics for memory & postgres stores
// ============================================================================

describe.each<[string, () => AuditLogStore]>([
  ["memory", () => new AppendOnlyAuditLogStore()],
  [
    "postgres",
    () => new PostgresAuditLogStore(new FakePostgresExecutor(), { integrityBatchSize: 2 }),
  ],
])("AuditLogStore contract (%s)", (_name, createStore) => {
  it("handles empty store (genesis state) with assertIntegrity() === true", async () => {
    const store = createStore();
    expect(await store.count()).toBe(0);
    expect(await store.list()).toEqual([]);
    expect(await store.assertIntegrity()).toBe(true);
  });

  it("maintains HMAC hash chain, 30-day retention, and rejects mutations", async () => {
    const store = createStore();
    const first = await store.append(makeInput("1", "2026-04-28T10:00:00.000Z"));
    const second = await store.append(makeInput("2", "2026-04-28T10:05:00.000Z"));

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.entryHash);
    expect(first.retentionUntil).toBe("2026-05-28T10:00:00.000Z");
    expect(await store.assertIntegrity()).toBe(true);

    await expect(async () => store.updateEntry(first.id, { action: "tampered" })).rejects.toThrow(
      "AUDIT_LOG_APPEND_ONLY",
    );
    await expect(async () => store.deleteEntry(second.id)).rejects.toThrow(
      "AUDIT_LOG_APPEND_ONLY",
    );
  });

  it("supports filtering, free-text search, pagination, and redacted exports", async () => {
    const store = createStore();
    await store.append(
      makeInput("a", "2026-04-28T10:00:00.000Z", {
        action: "stream.create",
        actor: { id: "alice", role: "admin" },
        metadata: { orgId: "org-1" },
      }),
    );
    await store.append(
      makeInput("b", "2026-04-28T11:00:00.000Z", {
        action: "stream.settle",
        actor: { id: "bob", role: "finance" },
        metadata: { orgId: "org-2" },
      }),
    );
    await store.append(
      makeInput("c", "2026-04-28T12:00:00.000Z", {
        action: "stream.settle",
        actor: { id: "alice", role: "admin" },
        metadata: { orgId: "org-1" },
      }),
    );

    const byOrg = await store.list({ orgId: "org-1" });
    expect(byOrg).toHaveLength(2);

    const bySearch = await store.list({ q: "bob" });
    expect(bySearch).toHaveLength(1);
    expect(bySearch[0].actor.id).toBe("bob");

    const page1 = await store.getPaginated({ limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.data).toHaveLength(2);
    expect(page1.hasNext).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.getPaginated({ limit: 2, cursor: page1.nextCursor });
    expect(page2.data).toHaveLength(1);
    expect(page2.hasNext).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const exported = await store.exportRows({ actorId: "bob" });
    expect(exported).toHaveLength(1);
    expect(exported[0].redactedTargetAccount).toBe("acct***rget");
    expect(exported[0].redactionPolicy).toBe("mask-target-account");
  });

  it("archives, restores, purges with checkpoints, and deep-archives while keeping chain intact", async () => {
    const store = createStore();
    await store.append(makeInput("1", "2024-01-01T10:00:00.000Z"));
    await store.append(makeInput("2", "2024-01-02T10:00:00.000Z"));
    await store.append(makeInput("3", "2026-06-01T10:00:00.000Z"));

    const archived = await store.archiveExpiredEntries("2024-02-10T00:00:00.000Z");
    expect(archived).toHaveLength(2);
    expect(await store.count()).toBe(1);
    expect(await store.getArchivedEntries()).toHaveLength(2);
    expect(await store.exportArchivedRows(10)).toHaveLength(2);
    expect(await store.assertIntegrity()).toBe(true);

    const restored = await store.restoreArchivedEntries();
    expect(restored).toHaveLength(2);
    expect(await store.count()).toBe(3);
    expect(await store.assertIntegrity()).toBe(true);

    const dryRun = await store.purgeArchivedRows("2025-01-01T00:00:00.000Z", false);
    expect(dryRun.executed).toBe(false);
    expect(dryRun.purgedEntries).toBe(2);
    expect(await store.count()).toBe(3);

    const purged = await store.purgeArchivedRows("2025-01-01T00:00:00.000Z", true);
    expect(purged.executed).toBe(true);
    expect(purged.purgedEntries).toBe(2);
    expect(purged.retainedEntries).toBe(1);
    expect(purged.chainIntactAfter).toBe(true);
    expect(purged.checkpointId).not.toBeNull();
    expect(await store.getCheckpoints()).toHaveLength(1);
    expect(await store.assertIntegrity()).toBe(true);

    const deep = await store.deepArchive("2027-01-01T00:00:00.000Z");
    expect(deep.archivedCount).toBe(1);
    expect(deep.chainIntactAfter).toBe(true);
    expect(await store.getDeepArchivedEntries()).toHaveLength(1);
    expect(await store.count()).toBe(0);
  });
});

// ============================================================================
// Postgres-specific behaviour & edge cases
// ============================================================================

describe("PostgresAuditLogStore", () => {
  it("persists entries across simulated process restarts and verifies integrity", async () => {
    const db = new FakePostgresExecutor();
    const storeBeforeRestart = new PostgresAuditLogStore(db);

    const e1 = await storeBeforeRestart.append(makeInput("r1", "2026-04-28T10:00:00.000Z"));
    const e2 = await storeBeforeRestart.append(makeInput("r2", "2026-04-28T10:01:00.000Z"));

    // Simulate a process restart by creating a brand-new store instance against the same DB
    const storeAfterRestart = new PostgresAuditLogStore(db, { integrityBatchSize: 1 });
    expect(await storeAfterRestart.count()).toBe(2);
    expect(await storeAfterRestart.assertIntegrity()).toBe(true);

    const e3 = await storeAfterRestart.append(makeInput("r3", "2026-04-28T10:02:00.000Z"));
    expect(e3.prevHash).toBe(e2.entryHash);
    expect(e2.prevHash).toBe(e1.entryHash);
    expect(await storeAfterRestart.assertIntegrity()).toBe(true);
  });

  it("detects tampering with hash or metadata", async () => {
    const db = new FakePostgresExecutor();
    const store = new PostgresAuditLogStore(db, { integrityBatchSize: 2 });

    const e1 = await store.append(makeInput("t1", "2026-04-28T10:00:00.000Z", { metadata: { note: "clean" } }));
    const e2 = await store.append(makeInput("t2", "2026-04-28T10:01:00.000Z", { metadata: { note: "clean" } }));
    expect(await store.assertIntegrity()).toBe(true);

    // Tamper metadata
    db.tamperEntry(e1.id, { metadata: { note: "tampered" } });
    expect(await store.assertIntegrity()).toBe(false);

    // Restore metadata and tamper hash
    db.tamperEntry(e1.id, { metadata: { note: "clean" } });
    expect(await store.assertIntegrity()).toBe(true);

    db.tamperEntry(e2.id, { hash: "deadbeef".repeat(8) });
    expect(await store.assertIntegrity()).toBe(false);
  });

  it("handles 1000 concurrent appends with an unbroken hash chain", async () => {
    const db = new FakePostgresExecutor();
    const store = new PostgresAuditLogStore(db, { integrityBatchSize: 100 });

    const appends = Array.from({ length: 1000 }, (_, i) =>
      store.append(
        makeInput(`c-${i}`, new Date(Date.UTC(2026, 3, 28, 0, 0, i)).toISOString()),
      ),
    );

    const results = await Promise.all(appends);
    expect(results).toHaveLength(1000);
    expect(await store.count()).toBe(1000);
    expect(await store.assertIntegrity()).toBe(true);
  });

  it("handles cursor pagination cleanly when rows are archived mid-pagination", async () => {
    const db = new FakePostgresExecutor();
    const store = new PostgresAuditLogStore(db);

    await store.append(makeInput("1", "2024-01-01T10:00:00.000Z"));
    await store.append(makeInput("2", "2024-01-02T10:00:00.000Z"));
    await store.append(makeInput("3", "2026-06-01T10:00:00.000Z"));
    await store.append(makeInput("4", "2026-06-02T10:00:00.000Z"));

    const page1 = await store.getPaginated({ limit: 2 });
    expect(page1.data.map((e) => e.target.id)).toEqual(["stream-4", "stream-3"]);
    expect(page1.nextCursor).not.toBeNull();

    // Archive the two 2024 entries before fetching page 2
    await store.archiveExpiredEntries("2024-03-01T00:00:00.000Z");

    const page2 = await store.getPaginated({ limit: 2, cursor: page1.nextCursor });
    expect(page2.data).toEqual([]);
    expect(page2.hasNext).toBe(false);
  });

  it("preserves unicode JSON metadata and keeps HMAC integrity intact", async () => {
    const db = new FakePostgresExecutor();
    const store = new PostgresAuditLogStore(db);

    const unicodeMeta = {
      note: "支払い完了 🚀 — café naïve résumé",
      orgId: "org-日本語-1",
    };

    const entry = await store.append(
      makeInput("u1", "2026-04-28T10:00:00.000Z", { metadata: unicodeMeta }),
    );

    expect(entry.metadata).toEqual(unicodeMeta);
    const [fetched] = await store.list({ orgId: "org-日本語-1" });
    expect(fetched.metadata).toEqual(unicodeMeta);
    expect(await store.assertIntegrity()).toBe(true);
  });

  it("uses parameterised SQL exclusively (no raw user input concatenated into SQL)", async () => {
    const db = new FakePostgresExecutor();
    const store = new PostgresAuditLogStore(db);

    const injectionPayload = "'; DROP TABLE audit_entries; --";
    await store.append(
      makeInput("inj", "2026-04-28T10:00:00.000Z", {
        action: injectionPayload,
        actor: { id: injectionPayload, role: "admin" },
        metadata: { orgId: injectionPayload },
      }),
    );

    await store.list({
      action: injectionPayload,
      actorId: injectionPayload,
      orgId: injectionPayload,
      q: injectionPayload,
    });

    for (const q of db.executedQueries) {
      expect(q.sql).not.toContain(injectionPayload);
    }
  });
});

// ============================================================================
// Configuration validation for AUDIT_LOG_STORE & DATABASE_URL
// ============================================================================

describe("validateConfig auditLog settings", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfigCache();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      STELLAR_NETWORK: "testnet",
      JWT_SECRET: "streampay-dev-secret-do-not-use-in-prod",
      ALLOWED_ORIGINS: "http://localhost:3000",
    };
    delete process.env.AUDIT_LOG_STORE;
    delete process.env.DATABASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
    resetConfigCache();
  });

  it("defaults AUDIT_LOG_STORE to memory", () => {
    const cfg = validateConfig();
    expect(cfg.auditLog.store).toBe("memory");
  });

  it("accepts AUDIT_LOG_STORE=postgres with a valid DATABASE_URL", () => {
    process.env.AUDIT_LOG_STORE = "postgres";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/streampay";
    const cfg = validateConfig();
    expect(cfg.auditLog).toEqual({
      store: "postgres",
      databaseUrl: "postgresql://user:pass@localhost:5432/streampay",
    });
  });

  it("rejects AUDIT_LOG_STORE=postgres when DATABASE_URL is missing or invalid", () => {
    process.env.AUDIT_LOG_STORE = "postgres";
    expect(() => validateConfig()).toThrow(ConfigValidationError);

    process.env.DATABASE_URL = "http://not-postgres.example.com";
    expect(() => validateConfig()).toThrow(ConfigValidationError);
  });

  it("rejects unsupported AUDIT_LOG_STORE values", () => {
    process.env.AUDIT_LOG_STORE = "sqlite";
    expect(() => validateConfig()).toThrow(ConfigValidationError);
  });
});

// ============================================================================
// Optional real-DB integration test (gated on DATABASE_URL)
// ============================================================================

const describeRealDb = process.env.DATABASE_URL ? describe : describe.skip;

describeRealDb("PostgresAuditLogStore (real DATABASE_URL)", () => {
  it("appends and verifies integrity against a live Postgres database", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require("pg") as typeof import("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const store = new PostgresAuditLogStore(pool as unknown as SqlExecutor);
      await store.reset([]);
      await store.append(makeInput("live-1", new Date().toISOString()));
      expect(await store.assertIntegrity()).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
