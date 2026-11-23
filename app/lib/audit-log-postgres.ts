import { randomUUID } from "crypto";
import type {
  AuditCheckpoint,
  AuditEntry,
  AuditEntryInput,
  AuditExportRow,
  AuditListFilters,
  AuditMetadataValue,
  AuditPurgeResult,
  DeepArchiveEntry,
  DeepArchiveResult,
} from "@/app/types/audit";
import type {
  AuditLogStore,
  AuditPaginatedResult,
} from "@/app/lib/audit-log-store";
import {
  addAuditRetention,
  auditLogStore as defaultMemoryAuditLogStore,
  computeEntryHash,
  hashAuditValue,
  toAuditExportRow,
} from "@/app/lib/audit-log";

/**
 * Minimal SQL executor contract compatible with `pg.Pool` and `pg.PoolClient`.
 * When `connect()` is provided (e.g. a `pg.Pool`), transactions acquire a
 * dedicated client so `BEGIN`, `pg_advisory_xact_lock`, and `COMMIT` execute
 * on the same session.
 */
export interface SqlClient {
  query<TResult = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: TResult[] }>;
  release?(): void;
}

export interface SqlExecutor extends SqlClient {
  connect?(): Promise<SqlClient>;
}

/**
 * Fixed 64-bit advisory lock key used to serialize hash-chain appends and
 * purge/archive mutations on `audit_entries`.
 */
export const AUDIT_LOG_ADVISORY_LOCK_KEY = 742910384729103;

const DEFAULT_INTEGRITY_BATCH_SIZE = 500;

interface AuditEntryRow {
  id: string;
  seq: string | number;
  ts: string | Date;
  ts_iso: string;
  actor_id: string;
  actor_role: AuditEntry["actor"]["role"];
  action: string;
  target_type: AuditEntry["target"]["type"];
  target_id: string;
  target_account: string | null;
  before_hash: string | null;
  after_hash: string | null;
  diff_hash: string | null;
  metadata: Record<string, AuditMetadataValue> | string | null;
  request_id: string;
  prev_hash: string | null;
  hash: string;
  retention_until: string | Date;
  retention_until_iso: string;
  archived_at: string | Date | null;
  deep_archived: boolean;
  deep_archived_at: string | Date | null;
}

interface AuditCheckpointRow {
  checkpoint_id: string;
  purged_count: number;
  first_purged_id: string;
  last_purged_id: string;
  last_purged_hash: string;
  cutoff: string | Date;
  created_at: string | Date;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseMetadata(
  raw: Record<string, AuditMetadataValue> | string | null | undefined,
): Record<string, AuditMetadataValue> | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string") {
    return JSON.parse(raw) as Record<string, AuditMetadataValue>;
  }
  return { ...raw };
}

function mapRowToEntry(row: AuditEntryRow): AuditEntry {
  const target: AuditEntry["target"] = {
    id: row.target_id,
    type: row.target_type,
  };
  if (row.target_account !== null && row.target_account !== undefined) {
    target.account = row.target_account;
  }

  return {
    action: row.action,
    actor: {
      id: row.actor_id,
      role: row.actor_role,
    },
    afterHash: row.after_hash,
    beforeHash: row.before_hash,
    diffHash: row.diff_hash,
    entryHash: row.hash,
    id: row.id,
    metadata: parseMetadata(row.metadata),
    prevHash: row.prev_hash,
    requestId: row.request_id,
    retentionUntil: row.retention_until_iso || toIsoString(row.retention_until),
    target,
    timestamp: row.ts_iso || toIsoString(row.ts),
  };
}

function mapRowToCheckpoint(row: AuditCheckpointRow): AuditCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    purgedCount: Number(row.purged_count),
    firstPurgedId: row.first_purged_id,
    lastPurgedId: row.last_purged_id,
    lastPurgedHash: row.last_purged_hash,
    cutoff: toIsoString(row.cutoff),
    createdAt: toIsoString(row.created_at),
  };
}

function decodeCursor(
  cursor: string | null | undefined,
): { timestamp: string; id: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parts = decoded.split("|");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { timestamp: parts[0], id: parts[1] };
    }
  } catch {
    // Ignore malformed cursor; caller handles validation when required.
  }
  return null;
}

function encodeCursor(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`).toString("base64");
}

function buildFilterWhereClauses(
  filters: AuditListFilters,
  params: unknown[],
): string[] {
  const clauses: string[] = [
    "archived_at IS NULL",
    "deep_archived = FALSE",
  ];

  if (filters.actorId) {
    params.push(filters.actorId);
    clauses.push(`actor_id = $${params.length}`);
  }
  if (filters.role) {
    params.push(filters.role);
    clauses.push(`actor_role = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    clauses.push(`action = $${params.length}`);
  }
  if (filters.targetId) {
    params.push(filters.targetId);
    clauses.push(`target_id = $${params.length}`);
  }
  if (filters.requestId) {
    params.push(filters.requestId);
    clauses.push(`request_id = $${params.length}`);
  }
  if (filters.orgId) {
    params.push(filters.orgId);
    clauses.push(`metadata->>'orgId' = $${params.length}`);
  }
  if (filters.startDate) {
    params.push(filters.startDate);
    clauses.push(`ts_iso >= $${params.length}`);
  }
  if (filters.endDate) {
    params.push(filters.endDate);
    clauses.push(`ts_iso <= $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    const idx = params.length;
    clauses.push(
      `LOWER(CONCAT_WS(' ', actor_id, actor_role, action, target_id, COALESCE(target_account, ''), request_id)) LIKE $${idx}`,
    );
  }

  return clauses;
}

const ENTRY_SELECT_COLUMNS = `
  id, seq, ts, ts_iso, actor_id, actor_role, action,
  target_type, target_id, target_account,
  before_hash, after_hash, diff_hash,
  metadata, request_id, prev_hash, hash,
  retention_until, retention_until_iso,
  archived_at, deep_archived, deep_archived_at
`.trim();

export interface PostgresAuditLogStoreOptions {
  /** Number of rows fetched per batch during `assertIntegrity()`. Default: 500. */
  integrityBatchSize?: number;
}

export class PostgresAuditLogStore implements AuditLogStore {
  private readonly integrityBatchSize: number;

  constructor(
    private readonly executor: SqlExecutor,
    options: PostgresAuditLogStoreOptions = {},
  ) {
    this.integrityBatchSize = Math.max(
      1,
      options.integrityBatchSize ?? DEFAULT_INTEGRITY_BATCH_SIZE,
    );
  }

  private async withTransaction<T>(
    fn: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    if (typeof this.executor.connect === "function") {
      const client = await this.executor.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve original error
        }
        throw error;
      } finally {
        client.release?.();
      }
    }

    await this.executor.query("BEGIN");
    try {
      const result = await fn(this.executor);
      await this.executor.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.executor.query("ROLLBACK");
      } catch {
        // Preserve original error
      }
      throw error;
    }
  }

  async append(input: AuditEntryInput): Promise<AuditEntry> {
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);

      const lastResult = await client.query<{ hash: string }>(
        `SELECT hash FROM audit_entries
         WHERE deep_archived = FALSE
         ORDER BY seq DESC
         LIMIT 1`,
      );

      const prevHash = lastResult.rows[0]?.hash ?? null;
      const timestamp = input.timestamp ?? new Date().toISOString();
      const beforeHash = input.before ? hashAuditValue(input.before) : null;
      const afterHash = input.after ? hashAuditValue(input.after) : null;
      const diffHash =
        input.diffHash ??
        (beforeHash || afterHash
          ? hashAuditValue({ afterHash, beforeHash })
          : null);

      const entryHash = computeEntryHash({
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

      const id = `audit-${randomUUID()}`;
      const retentionUntil = addAuditRetention(timestamp);
      const metadataJson =
        input.metadata !== undefined ? JSON.stringify(input.metadata) : null;

      const inserted = await client.query<AuditEntryRow>(
        `INSERT INTO audit_entries (
          id, ts, ts_iso, actor_id, actor_role, action,
          target_type, target_id, target_account,
          before_hash, after_hash, diff_hash,
          metadata, request_id, prev_hash, hash,
          retention_until, retention_until_iso
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9,
          $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18
        )
        RETURNING ${ENTRY_SELECT_COLUMNS}`,
        [
          id,
          timestamp,
          timestamp,
          input.actor.id,
          input.actor.role,
          input.action,
          input.target.type,
          input.target.id,
          input.target.account ?? null,
          beforeHash,
          afterHash,
          diffHash,
          metadataJson,
          input.requestId,
          prevHash,
          entryHash,
          retentionUntil,
          retentionUntil,
        ],
      );

      return mapRowToEntry(inserted.rows[0]);
    });
  }

  async list(filters: AuditListFilters = {}): Promise<AuditEntry[]> {
    const page = await this.getPaginated(filters);
    return page.data;
  }

  async getPaginated(
    filters: AuditListFilters = {},
  ): Promise<AuditPaginatedResult> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 250);

    const countParams: unknown[] = [];
    const baseClauses = buildFilterWhereClauses(filters, countParams);
    const countSql = `SELECT COUNT(*)::int AS total FROM audit_entries WHERE ${baseClauses.join(" AND ")}`;
    const countRes = await this.executor.query<{ total: number | string }>(
      countSql,
      countParams,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const pageParams: unknown[] = [];
    const pageClauses = buildFilterWhereClauses(filters, pageParams);

    const decoded = decodeCursor(filters.cursor);
    if (decoded) {
      pageParams.push(decoded.timestamp);
      const tsIdx = pageParams.length;
      pageParams.push(decoded.id);
      const idIdx = pageParams.length;
      pageClauses.push(
        `(ts_iso < $${tsIdx} OR (ts_iso = $${tsIdx} AND id < $${idIdx}))`,
      );
    }

    pageParams.push(limit + 1);
    const limitIdx = pageParams.length;

    const pageSql = `SELECT ${ENTRY_SELECT_COLUMNS}
      FROM audit_entries
      WHERE ${pageClauses.join(" AND ")}
      ORDER BY ts_iso DESC, id DESC
      LIMIT $${limitIdx}`;

    const pageRes = await this.executor.query<AuditEntryRow>(
      pageSql,
      pageParams,
    );

    const hasNext = pageRes.rows.length > limit;
    const sliced = pageRes.rows.slice(0, limit).map(mapRowToEntry);

    let nextCursor: string | null = null;
    if (hasNext && sliced.length > 0) {
      const lastEntry = sliced[sliced.length - 1];
      nextCursor = encodeCursor(lastEntry.timestamp, lastEntry.id);
    }

    return {
      data: sliced,
      hasNext,
      nextCursor,
      total,
    };
  }

  async exportRows(filters: AuditListFilters = {}): Promise<AuditExportRow[]> {
    const page = await this.getPaginated({
      ...filters,
      limit: Number.MAX_SAFE_INTEGER,
    });
    return page.data.map(toAuditExportRow);
  }

  async exportArchivedRows(limit = 250): Promise<AuditExportRow[]> {
    const capped = Math.min(Math.max(limit, 1), 250);
    const res = await this.executor.query<AuditEntryRow>(
      `SELECT ${ENTRY_SELECT_COLUMNS}
       FROM audit_entries
       WHERE archived_at IS NOT NULL OR deep_archived = TRUE
       ORDER BY ts_iso DESC
       LIMIT $1`,
      [capped],
    );
    return res.rows.map((row) => toAuditExportRow(mapRowToEntry(row)));
  }

  async archiveExpiredEntries(
    referenceTimestamp: string | Date = new Date().toISOString(),
  ): Promise<AuditEntry[]> {
    const cutoffIso =
      referenceTimestamp instanceof Date
        ? referenceTimestamp.toISOString()
        : new Date(referenceTimestamp).toISOString();
    const archivedAt = new Date().toISOString();

    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);

      const res = await client.query<AuditEntryRow>(
        `UPDATE audit_entries
         SET archived_at = $1
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND retention_until <= $2
         RETURNING ${ENTRY_SELECT_COLUMNS}`,
        [archivedAt, cutoffIso],
      );

      return res.rows
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map(mapRowToEntry);
    });
  }

  async restoreArchivedEntries(): Promise<AuditEntry[]> {
    return this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);

      const res = await client.query<AuditEntryRow>(
        `UPDATE audit_entries
         SET archived_at = NULL
         WHERE archived_at IS NOT NULL
           AND deep_archived = FALSE
         RETURNING ${ENTRY_SELECT_COLUMNS}`,
      );

      return res.rows
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map(mapRowToEntry);
    });
  }

  async getArchivedEntries(): Promise<AuditEntry[]> {
    const res = await this.executor.query<AuditEntryRow>(
      `SELECT ${ENTRY_SELECT_COLUMNS}
       FROM audit_entries
       WHERE archived_at IS NOT NULL
         AND deep_archived = FALSE
       ORDER BY seq ASC`,
    );
    return res.rows.map(mapRowToEntry);
  }

  async count(): Promise<number> {
    const res = await this.executor.query<{ total: number | string }>(
      `SELECT COUNT(*)::int AS total
       FROM audit_entries
       WHERE archived_at IS NULL
         AND deep_archived = FALSE`,
    );
    return Number(res.rows[0]?.total ?? 0);
  }

  async assertIntegrity(): Promise<boolean> {
    const checkpoints = await this.getCheckpoints();
    let lastSeq = 0;
    let isFirst = true;
    let previousHash: string | null = null;

    while (true) {
      const batch = await this.executor.query<AuditEntryRow>(
        `SELECT ${ENTRY_SELECT_COLUMNS}
         FROM audit_entries
         WHERE deep_archived = FALSE
           AND seq > $1
         ORDER BY seq ASC
         LIMIT $2`,
        [lastSeq, this.integrityBatchSize],
      );

      if (batch.rows.length === 0) {
        return true;
      }

      for (const row of batch.rows) {
        const entry = mapRowToEntry(row);

        if (isFirst) {
          const validGenesis = entry.prevHash === null;
          const validCheckpoint = checkpoints.some(
            (cp) => cp.lastPurgedHash === entry.prevHash,
          );
          if (!validGenesis && !validCheckpoint) {
            return false;
          }
          previousHash = entry.prevHash;
          isFirst = false;
        }

        const recalculatedHash = computeEntryHash({
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
        lastSeq = Number(row.seq);
      }

      if (batch.rows.length < this.integrityBatchSize) {
        return true;
      }
    }
  }

  async updateEntry(
    _id: string,
    _changes: Partial<AuditEntry>,
  ): Promise<never> {
    throw new Error("AUDIT_LOG_APPEND_ONLY");
  }

  async deleteEntry(_id: string): Promise<never> {
    throw new Error("AUDIT_LOG_APPEND_ONLY");
  }

  async purgeArchivedRows(
    cutoffTimestamp: string,
    execute = false,
  ): Promise<AuditPurgeResult> {
    const cutoffMs = Date.parse(cutoffTimestamp);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error("INVALID_PURGE_CUTOFF");
    }
    const cutoffIso = new Date(cutoffMs).toISOString();

    const chainIntactBefore = await this.assertIntegrity();

    if (!execute) {
      const purgedRes = await this.executor.query<{ id: string }>(
        `SELECT id FROM audit_entries
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND ts < $1
         ORDER BY seq ASC`,
        [cutoffIso],
      );
      const retainedRes = await this.executor.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM audit_entries
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND ts >= $1`,
        [cutoffIso],
      );

      return {
        chainIntactAfter: chainIntactBefore,
        chainIntactBefore,
        cutoffTimestamp: cutoffIso,
        executed: false,
        purgedEntries: purgedRes.rows.length,
        purgedIds: purgedRes.rows.map((r) => r.id),
        retainedEntries: Number(retainedRes.rows[0]?.total ?? 0),
        checkpointId: null,
      };
    }

    const result = await this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);

      const toPurgeRes = await client.query<AuditEntryRow>(
        `SELECT ${ENTRY_SELECT_COLUMNS}
         FROM audit_entries
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND ts < $1
         ORDER BY seq ASC`,
        [cutoffIso],
      );

      const retainedRes = await client.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM audit_entries
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND ts >= $1`,
        [cutoffIso],
      );
      const retainedEntries = Number(retainedRes.rows[0]?.total ?? 0);

      if (toPurgeRes.rows.length === 0) {
        return {
          purgedEntries: 0,
          purgedIds: [] as string[],
          retainedEntries,
          checkpointId: null as string | null,
        };
      }

      const firstPurged = toPurgeRes.rows[0];
      const lastPurged = toPurgeRes.rows[toPurgeRes.rows.length - 1];
      const checkpointId = `audit-checkpoint-${randomUUID()}`;
      const createdAt = new Date().toISOString();

      await client.query(
        `INSERT INTO audit_checkpoints (
          checkpoint_id, purged_count, first_purged_id,
          last_purged_id, last_purged_hash, cutoff, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          checkpointId,
          toPurgeRes.rows.length,
          firstPurged.id,
          lastPurged.id,
          lastPurged.hash,
          cutoffIso,
          createdAt,
        ],
      );

      await client.query("SELECT set_config($1, $2, true)", [
        "app.audit_allow_purge",
        "on",
      ]);

      await client.query(
        `DELETE FROM audit_entries
         WHERE archived_at IS NULL
           AND deep_archived = FALSE
           AND ts < $1`,
        [cutoffIso],
      );

      return {
        purgedEntries: toPurgeRes.rows.length,
        purgedIds: toPurgeRes.rows.map((r) => r.id),
        retainedEntries,
        checkpointId,
      };
    });

    const chainIntactAfter = await this.assertIntegrity();

    return {
      chainIntactAfter,
      chainIntactBefore,
      cutoffTimestamp: cutoffIso,
      executed: true,
      purgedEntries: result.purgedEntries,
      purgedIds: result.purgedIds,
      retainedEntries: result.retainedEntries,
      checkpointId: result.checkpointId,
    };
  }

  async deepArchive(cutoffTimestamp: string): Promise<DeepArchiveResult> {
    const cutoffMs = Date.parse(cutoffTimestamp);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error("INVALID_ARCHIVE_CUTOFF");
    }
    const cutoffIso = new Date(cutoffMs).toISOString();
    const archivedAt = new Date().toISOString();

    const chainIntactBefore = await this.assertIntegrity();

    const result = await this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);

      const toArchiveRes = await client.query<AuditEntryRow>(
        `SELECT ${ENTRY_SELECT_COLUMNS}
         FROM audit_entries
         WHERE deep_archived = FALSE
           AND ts < $1
         ORDER BY seq ASC`,
        [cutoffIso],
      );

      if (toArchiveRes.rows.length === 0) {
        return {
          archivedCount: 0,
          archivedEntryIds: [] as string[],
          checkpointId: null as string | null,
        };
      }

      const firstArchived = toArchiveRes.rows[0];
      const lastArchived = toArchiveRes.rows[toArchiveRes.rows.length - 1];
      const checkpointId = `audit-checkpoint-${randomUUID()}`;

      await client.query(
        `INSERT INTO audit_checkpoints (
          checkpoint_id, purged_count, first_purged_id,
          last_purged_id, last_purged_hash, cutoff, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          checkpointId,
          toArchiveRes.rows.length,
          firstArchived.id,
          lastArchived.id,
          lastArchived.hash,
          cutoffIso,
          archivedAt,
        ],
      );

      await client.query(
        `UPDATE audit_entries
         SET deep_archived = TRUE,
             deep_archived_at = $1
         WHERE deep_archived = FALSE
           AND ts < $2`,
        [archivedAt, cutoffIso],
      );

      return {
        archivedCount: toArchiveRes.rows.length,
        archivedEntryIds: toArchiveRes.rows.map((r) => r.id),
        checkpointId,
      };
    });

    const chainIntactAfter = await this.assertIntegrity();

    return {
      archivedCount: result.archivedCount,
      archivedEntryIds: result.archivedEntryIds,
      chainIntactBefore,
      chainIntactAfter,
      cutoffTimestamp: cutoffIso,
      archivedAt,
      checkpointId: result.checkpointId,
    };
  }

  async getDeepArchivedEntries(): Promise<DeepArchiveEntry[]> {
    const res = await this.executor.query<AuditEntryRow>(
      `SELECT ${ENTRY_SELECT_COLUMNS}
       FROM audit_entries
       WHERE deep_archived = TRUE
       ORDER BY seq ASC`,
    );

    return res.rows.map((row) => ({
      entry: mapRowToEntry(row),
      archivedAt: row.deep_archived_at
        ? toIsoString(row.deep_archived_at)
        : toIsoString(row.ts),
    }));
  }

  async reset(seedEntries: AuditEntryInput[] = []): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [
        AUDIT_LOG_ADVISORY_LOCK_KEY,
      ]);
      await client.query("SELECT set_config($1, $2, true)", [
        "app.audit_allow_purge",
        "on",
      ]);
      await client.query("DELETE FROM audit_entries");
      await client.query("DELETE FROM audit_checkpoints");
    });

    for (const entry of seedEntries) {
      await this.append(entry);
    }
  }

  async getCheckpoints(): Promise<AuditCheckpoint[]> {
    const res = await this.executor.query<AuditCheckpointRow>(
      `SELECT checkpoint_id, purged_count, first_purged_id,
              last_purged_id, last_purged_hash, cutoff, created_at
       FROM audit_checkpoints
       ORDER BY created_at ASC`,
    );
    return res.rows.map(mapRowToCheckpoint);
  }
}

let configuredPostgresStore: PostgresAuditLogStore | null = null;

/**
 * Returns the audit log store selected by `AUDIT_LOG_STORE` (`memory` | `postgres`).
 * Defaults to the in-memory `auditLogStore` singleton when unset or set to `memory`.
 */
export function getConfiguredAuditLogStore(): AuditLogStore {
  const mode = (process.env.AUDIT_LOG_STORE ?? "memory").trim().toLowerCase();
  if (mode === "postgres") {
    if (!configuredPostgresStore) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error(
          "DATABASE_URL is required when AUDIT_LOG_STORE=postgres",
        );
      }
      // Imported lazily so client bundles and unit tests never load `pg`.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Pool } = require("pg") as typeof import("pg");
      const pool = new Pool({ connectionString: databaseUrl });
      configuredPostgresStore = new PostgresAuditLogStore(
        pool as unknown as SqlExecutor,
      );
    }
    return configuredPostgresStore;
  }
  return defaultMemoryAuditLogStore;
}

export function resetConfiguredAuditLogStore(): void {
  configuredPostgresStore = null;
}
