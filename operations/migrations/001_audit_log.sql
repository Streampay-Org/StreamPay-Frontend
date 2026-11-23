-- Migration: 001_audit_log.sql
-- Description: Persist append-only audit log entries and purge/archive checkpoints in Postgres.

-- ============================================================================
-- Up
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_entries (
  id TEXT PRIMARY KEY,
  seq BIGSERIAL NOT NULL UNIQUE,
  ts TIMESTAMPTZ NOT NULL,
  ts_iso TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account TEXT,
  before_hash TEXT,
  after_hash TEXT,
  diff_hash TEXT,
  metadata JSONB,
  request_id TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  retention_until_iso TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  deep_archived BOOLEAN NOT NULL DEFAULT FALSE,
  deep_archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_entries_active_order
  ON audit_entries (ts_iso DESC, id DESC)
  WHERE archived_at IS NULL AND deep_archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_audit_entries_seq_active
  ON audit_entries (seq ASC)
  WHERE deep_archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_audit_entries_actor_id
  ON audit_entries (actor_id);

CREATE INDEX IF NOT EXISTS idx_audit_entries_action
  ON audit_entries (action);

CREATE INDEX IF NOT EXISTS idx_audit_entries_target_id
  ON audit_entries (target_id);

CREATE INDEX IF NOT EXISTS idx_audit_entries_request_id
  ON audit_entries (request_id);

CREATE INDEX IF NOT EXISTS idx_audit_entries_retention_until
  ON audit_entries (retention_until)
  WHERE archived_at IS NULL AND deep_archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_audit_entries_metadata_org_id
  ON audit_entries ((metadata->>'orgId'))
  WHERE metadata IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  purged_count INTEGER NOT NULL CHECK (purged_count >= 0),
  first_purged_id TEXT NOT NULL,
  last_purged_id TEXT NOT NULL,
  last_purged_hash TEXT NOT NULL,
  cutoff TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_created_at
  ON audit_checkpoints (created_at ASC);

-- Enforce append-only semantics at the database level:
-- - UPDATE may only modify archive lifecycle flags (archived_at, deep_archived, deep_archived_at).
-- - DELETE is rejected unless explicitly authorized inside a checkpointed purge transaction
--   via `SELECT set_config('app.audit_allow_purge', 'on', true)`.
CREATE OR REPLACE FUNCTION prevent_audit_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.audit_allow_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'AUDIT_LOG_APPEND_ONLY: direct DELETE on audit_entries is prohibited';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.ts IS DISTINCT FROM OLD.ts
       OR NEW.ts_iso IS DISTINCT FROM OLD.ts_iso
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
       OR NEW.action IS DISTINCT FROM OLD.action
       OR NEW.target_type IS DISTINCT FROM OLD.target_type
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.target_account IS DISTINCT FROM OLD.target_account
       OR NEW.before_hash IS DISTINCT FROM OLD.before_hash
       OR NEW.after_hash IS DISTINCT FROM OLD.after_hash
       OR NEW.diff_hash IS DISTINCT FROM OLD.diff_hash
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.prev_hash IS DISTINCT FROM OLD.prev_hash
       OR NEW.hash IS DISTINCT FROM OLD.hash
       OR NEW.retention_until IS DISTINCT FROM OLD.retention_until
       OR NEW.retention_until_iso IS DISTINCT FROM OLD.retention_until_iso
    THEN
      RAISE EXCEPTION 'AUDIT_LOG_APPEND_ONLY: immutable columns on audit_entries cannot be updated';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_entries_append_only ON audit_entries;
CREATE TRIGGER trg_audit_entries_append_only
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_entry_mutation();

-- ============================================================================
-- Down
-- ============================================================================

-- DROP TRIGGER IF EXISTS trg_audit_entries_append_only ON audit_entries;
-- DROP FUNCTION IF EXISTS prevent_audit_entry_mutation();
-- DROP TABLE IF EXISTS audit_checkpoints;
-- DROP TABLE IF EXISTS audit_entries;
