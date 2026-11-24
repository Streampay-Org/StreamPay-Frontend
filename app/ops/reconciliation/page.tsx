"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBigInt } from "@/lib/format-bigint";
import {
  buildAdminAuthHeaders,
  readAdminCredential,
  writeAdminCredential,
} from "./admin-credential";
import styles from "./reconciliation.module.css";

/**
 * Operations dashboard for reconciliation: last run, dependency health,
 * a cursor-paged discrepancy list and a per-stream DB-vs-chain diff drawer.
 *
 * API contract
 * - `GET /api/reconciliation`           → `{ data, meta: { hasNext, nextCursor } }`
 * - `GET /api/reconciliation/health`    → 200 when ok, 503 when degraded
 * - `GET /api/reconciliation/diff/:id`  → admin-gated stream diff
 *
 * The page polls at most once every 30 s. A 429 pauses polling and shows the
 * `Retry-After` countdown; a 503 health probe is rendered as a degraded state
 * rather than a generic fetch failure.
 */

export const AUTO_REFRESH_MS = 30_000;
const PAGE_SIZE = 20;

export type ReconciliationRunStatus = "completed" | "pending" | "failed";

export interface ReconciliationRun {
  id: string;
  totalReconciled: string | number;
  currency: string;
  status: ReconciliationRunStatus;
  created_at: string;
}

export interface ReconciliationHealthCheck {
  status: "ok" | "degraded";
  message?: string;
  checked_at: string;
}

export interface ReconciliationHealth {
  status: "ok" | "degraded";
  checks: {
    database: ReconciliationHealthCheck;
    onchain: ReconciliationHealthCheck;
  };
}

export interface StreamDiffField {
  field: string;
  dbValue: string | number;
  onChainValue: string | number;
  toleranceApplied: boolean;
}

export interface StreamDiff {
  streamId: string;
  checkedAt: string;
  inSync: boolean;
  diffs: StreamDiffField[];
}

type ListState = "loading" | "ready" | "error";
type HealthState = "loading" | "ready" | "degraded" | "error";
type DiffState = "idle" | "loading" | "ready" | "error";

/** Format a base-unit amount for display, leaving non-numeric fields intact. */
export function formatAmount(value: string | number): string {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return raw;
  try {
    return formatBigInt(BigInt(raw));
  } catch {
    return raw;
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return AUTO_REFRESH_MS / 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return AUTO_REFRESH_MS / 1000;
}

export function buildRunsUrl(options: {
  limit?: number;
  cursor?: string | null;
  status?: string;
}): string {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? PAGE_SIZE));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.status) params.set("status", options.status);
  return `/api/reconciliation?${params.toString()}`;
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function ReconciliationOpsPage() {
  const [runs, setRuns] = useState<ReconciliationRun[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [listState, setListState] = useState<ListState>("loading");
  const [listError, setListError] = useState<string | null>(null);

  const [health, setHealth] = useState<ReconciliationHealth | null>(null);
  const [healthState, setHealthState] = useState<HealthState>("loading");

  const [rateLimitSeconds, setRateLimitSeconds] = useState<number | null>(null);

  const [credential, setCredential] = useState("");
  const [selectedRun, setSelectedRun] = useState<ReconciliationRun | null>(null);
  const [diffState, setDiffState] = useState<DiffState>("idle");
  const [diff, setDiff] = useState<StreamDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const rateLimitedRef = useRef(false);
  useEffect(() => {
    rateLimitedRef.current = rateLimitSeconds !== null;
  }, [rateLimitSeconds]);

  useEffect(() => {
    setCredential(readAdminCredential());
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/reconciliation/health", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = await safeJson(response);

      if (response.status === 503) {
        setHealth(body && body.checks ? body : null);
        setHealthState("degraded");
        return;
      }
      if (!response.ok) throw new Error(`Health probe failed (${response.status})`);

      setHealth(body);
      setHealthState(body?.status === "degraded" ? "degraded" : "ready");
    } catch {
      setHealthState("error");
    }
  }, []);

  const loadPage = useCallback(
    async (cursor: string | null, append: boolean, options: { silent?: boolean } = {}) => {
      if (rateLimitedRef.current) return;
      if (!append && !options.silent) {
        setListState("loading");
      }
      setListError(null);

      try {
        let useCursor = cursor;
        let useAppend = append;

        // One retry is enough: a stale cursor is reset to the first page.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(
            buildRunsUrl({ limit: PAGE_SIZE, cursor: useCursor, status: statusFilter }),
            { headers: { Accept: "application/json" }, cache: "no-store" },
          );

          if (response.status === 429) {
            setRateLimitSeconds(parseRetryAfter(response.headers.get("Retry-After")));
            setListState("ready");
            return;
          }

          if (response.status === 422) {
            const body = await safeJson(response);
            if (body?.error?.code === "INVALID_CURSOR" && useCursor) {
              useCursor = null;
              useAppend = false;
              continue;
            }
            throw new Error(body?.error?.message ?? "Reconciliation query was rejected.");
          }

          if (!response.ok) {
            throw new Error(`Could not load reconciliation runs (${response.status}).`);
          }

          const body = await safeJson(response);
          const data: ReconciliationRun[] = Array.isArray(body?.data) ? body.data : [];
          setRuns((previous) => (useAppend ? [...previous, ...data] : data));
          setNextCursor(body?.meta?.nextCursor ?? null);
          setHasNext(Boolean(body?.meta?.hasNext));
          setListState("ready");
          return;
        }

        throw new Error("Could not load reconciliation runs.");
      } catch (error) {
        setListError(
          error instanceof Error ? error.message : "Could not load reconciliation runs.",
        );
        setListState("error");
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  useEffect(() => {
    void loadPage(null, false);
  }, [loadPage]);

  const refreshAll = useCallback(() => {
    void loadHealth();
    void loadPage(null, false, { silent: true });
  }, [loadHealth, loadPage]);

  // Polling is paused while a 429 countdown is active.
  useEffect(() => {
    if (rateLimitSeconds !== null) return;
    const timer = setInterval(refreshAll, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [rateLimitSeconds, refreshAll]);

  useEffect(() => {
    if (rateLimitSeconds === null) return;
    if (rateLimitSeconds <= 0) {
      setRateLimitSeconds(null);
      return;
    }
    const timer = setTimeout(
      () => setRateLimitSeconds((seconds) => (seconds === null ? null : seconds - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [rateLimitSeconds]);

  const closeDiff = useCallback(() => {
    setSelectedRun(null);
    setDiff(null);
    setDiffError(null);
    setDiffState("idle");
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDiff();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRun, closeDiff]);

  const openDiff = useCallback(
    async (run: ReconciliationRun) => {
      setSelectedRun(run);
      setDiff(null);
      setDiffError(null);

      if (!credential.trim()) {
        setDiffState("error");
        setDiffError("Add an admin credential above to load stream diffs.");
        return;
      }

      setDiffState("loading");
      try {
        const response = await fetch(
          `/api/reconciliation/diff/${encodeURIComponent(run.id)}`,
          {
            headers: {
              Accept: "application/json",
              ...buildAdminAuthHeaders(credential),
            },
            cache: "no-store",
          },
        );

        if (response.status === 429) {
          setRateLimitSeconds(parseRetryAfter(response.headers.get("Retry-After")));
          setDiffState("error");
          setDiffError("Rate limited. The diff will be available again shortly.");
          return;
        }
        if (response.status === 401 || response.status === 403) {
          setDiffState("error");
          setDiffError("Admin authorization required. Check the admin credential.");
          return;
        }
        if (response.status === 404) {
          setDiffState("error");
          setDiffError(`Stream '${run.id}' was not found.`);
          return;
        }
        if (!response.ok) {
          throw new Error(`Could not load the stream diff (${response.status}).`);
        }

        const body = await safeJson(response);
        setDiff(body?.data ?? null);
        setDiffState("ready");
      } catch (error) {
        setDiffState("error");
        setDiffError(
          error instanceof Error ? error.message : "Could not load the stream diff.",
        );
      }
    },
    [credential],
  );

  const lastRun = runs[0] ?? null;
  const rateLimited = rateLimitSeconds !== null;

  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">Operations</p>
          <h1 className="page-hero__title">Reconciliation</h1>
          <p className="page-hero__description">
            Compare database and on-chain state, review the latest run and inspect
            per-stream differences.
          </p>
        </div>
      </header>

      {rateLimited && (
        <div className={`${styles.banner} ${styles.bannerWarning}`} role="status">
          <strong>Rate limited.</strong> Auto-refresh is paused. Next attempt in{" "}
          <span aria-live="polite">{rateLimitSeconds}s</span>.
        </div>
      )}

      {healthState === "degraded" && (
        <div className={`${styles.banner} ${styles.bannerWarning}`} role="alert">
          <strong>Reconciliation health is degraded.</strong> At least one dependency
          check is failing. New runs may not complete until it recovers.
        </div>
      )}

      {healthState === "error" && (
        <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
          <strong>Health check unavailable.</strong> Could not read the reconciliation
          health endpoint.
        </div>
      )}

      <section className={styles.panel} aria-labelledby="last-run-heading">
        <h2 id="last-run-heading" className={styles.panelTitle}>
          Last run
        </h2>
        {lastRun ? (
          <dl className={styles.summaryGrid}>
            <div>
              <dt>Run</dt>
              <dd>{lastRun.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusChip status={lastRun.status} />
              </dd>
            </div>
            <div>
              <dt>Reconciled</dt>
              <dd>
                {formatAmount(lastRun.totalReconciled)} {lastRun.currency}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatTimestamp(lastRun.created_at)}</dd>
            </div>
          </dl>
        ) : (
          <p className={styles.muted}>
            {listState === "loading" ? "Loading the latest run…" : "No runs recorded yet."}
          </p>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="health-heading">
        <h2 id="health-heading" className={styles.panelTitle}>
          Health checks
        </h2>
        <div className={styles.healthGrid}>
          <HealthCard
            label="Database"
            check={health?.checks.database}
            loading={healthState === "loading"}
          />
          <HealthCard
            label="On-chain"
            check={health?.checks.onchain}
            loading={healthState === "loading"}
          />
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="runs-heading">
        <div className={styles.panelHeader}>
          <h2 id="runs-heading" className={styles.panelTitle}>
            Discrepancies
          </h2>
          <div className={styles.controls}>
            <label className={styles.controlLabel} htmlFor="status-filter">
              Status
              <select
                id="status-filter"
                className={styles.select}
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="">All</option>
                <option value="completed">Completed</option>
                <option value="pending">Pending</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={refreshAll}
              disabled={rateLimited || listState === "loading"}
            >
              Refresh
            </button>
          </div>
        </div>

        <div className={styles.credential}>
          <label className={styles.controlLabel} htmlFor="admin-credential">
            Admin credential
            <input
              id="admin-credential"
              className={styles.input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Admin JWT or wallet address"
              value={credential}
              onChange={(event) => {
                setCredential(event.target.value);
                writeAdminCredential(event.target.value);
              }}
            />
          </label>
          <p className={styles.hint}>
            Required for stream diffs. Kept in this tab&apos;s session only.
          </p>
        </div>

        {listState === "error" && (
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
            <strong>Could not load discrepancies.</strong> {listError}
            <button
              type="button"
              className="button button--secondary button--sm"
              onClick={() => void loadPage(null, false)}
            >
              Retry
            </button>
          </div>
        )}

        {listState === "loading" && runs.length === 0 ? (
          <p className={styles.muted} role="status">
            Loading reconciliation runs…
          </p>
        ) : runs.length === 0 ? (
          <p className={styles.muted}>
            {rateLimited
              ? "No runs loaded yet — the API is rate limited."
              : "No reconciliation runs found for this filter."}
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>
                Reconciliation runs with total reconciled, status and creation time
              </caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Total reconciled</th>
                  <th scope="col">Currency</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row">{run.id}</th>
                    <td>{formatAmount(run.totalReconciled)}</td>
                    <td>{run.currency}</td>
                    <td>
                      <StatusChip status={run.status} />
                    </td>
                    <td>{formatTimestamp(run.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="button button--secondary button--sm"
                        onClick={() => void openDiff(run)}
                        aria-label={`View diff for ${run.id}`}
                      >
                        View diff
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasNext && (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void loadPage(nextCursor, true)}
            disabled={rateLimited || listState === "loading"}
          >
            Load more
          </button>
        )}
      </section>

      {selectedRun && (
        <div className={styles.drawerBackdrop} role="presentation" onClick={closeDiff}>
          <aside
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-labelledby="diff-heading"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.drawerHeader}>
              <h2 id="diff-heading" className={styles.drawerTitle}>
                Stream diff: {selectedRun.id}
              </h2>
              <button
                type="button"
                className="button button--ghost button--sm"
                onClick={closeDiff}
                aria-label="Close diff"
              >
                Close
              </button>
            </div>

            {diffState === "loading" && (
              <p className={styles.muted} role="status">
                Loading diff…
              </p>
            )}

            {diffState === "error" && (
              <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
                {diffError}
              </div>
            )}

            {diffState === "ready" && diff && (
              <div>
                <p
                  className={diff.inSync ? styles.syncOk : styles.syncBad}
                  data-testid="diff-sync-state"
                >
                  {diff.inSync
                    ? "In sync — no field differences."
                    : `${diff.diffs.length} mismatched field${diff.diffs.length === 1 ? "" : "s"}.`}
                </p>

                {diff.diffs.length === 0 ? (
                  <p className={styles.muted}>Nothing to reconcile for this stream.</p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <caption className={styles.visuallyHidden}>
                        Field-by-field diff for {diff.streamId}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Field</th>
                          <th scope="col">DB value</th>
                          <th scope="col">On-chain value</th>
                          <th scope="col">Tolerance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.diffs.map((entry) => (
                          <tr key={entry.field} className={styles.mismatchRow}>
                            <th scope="row">{entry.field}</th>
                            <td>{formatAmount(entry.dbValue)}</td>
                            <td>{formatAmount(entry.onChainValue)}</td>
                            <td>{entry.toleranceApplied ? "Applied" : "None"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className={styles.hint}>Checked {formatTimestamp(diff.checkedAt)}</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: ReconciliationRunStatus }) {
  const tone =
    status === "completed"
      ? styles.chipCompleted
      : status === "pending"
        ? styles.chipPending
        : styles.chipFailed;
  return <span className={`${styles.chip} ${tone}`}>{status}</span>;
}

function HealthCard({
  label,
  check,
  loading,
}: {
  label: string;
  check?: ReconciliationHealthCheck;
  loading: boolean;
}) {
  const status = check?.status;
  const healthy = status === "ok";
  const tone =
    loading || !status ? styles.healthUnknown : healthy ? styles.healthOk : styles.healthBad;
  const statusLabel = loading ? "Checking…" : !status ? "Unknown" : healthy ? "Healthy" : "Degraded";

  return (
    <div className={`${styles.healthCard} ${tone}`}>
      <h3 className={styles.healthTitle}>{label}</h3>
      <p className={styles.healthStatus}>
        <span aria-hidden="true">{healthy ? "✓" : status ? "!" : "?"}</span> {statusLabel}
      </p>
      {check?.message && <p className={styles.hint}>{check.message}</p>}
      {check?.checked_at && (
        <p className={styles.hint}>Checked {formatTimestamp(check.checked_at)}</p>
      )}
    </div>
  );
}
