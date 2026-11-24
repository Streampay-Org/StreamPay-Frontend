"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { DateRangePicker } from "@/app/components/DateRangePicker";
import { LiveRegion } from "@/app/components/LiveRegion";
import type { AuditActorRole, AuditEntry } from "@/app/types/audit";
import type { AuditResponseDTO } from "@/app/lib/dtos/audit.dto";

const AUDIT_ROLES: AuditActorRole[] = [
  "user",
  "support",
  "admin",
  "finance",
  "security",
  "compliance",
  "system",
];

export interface AuditFilterState {
  actorId: string;
  action: string;
  role: AuditActorRole | "";
  targetId: string;
  q: string;
  startDate: string;
  endDate: string;
}

const EMPTY_FILTERS: AuditFilterState = {
  actorId: "",
  action: "",
  role: "",
  targetId: "",
  q: "",
  startDate: "",
  endDate: "",
};

function parseFiltersFromSearch(search: string): AuditFilterState {
  const params = new URLSearchParams(search);
  const rawRole = params.get("role") ?? "";
  const role = AUDIT_ROLES.includes(rawRole as AuditActorRole)
    ? (rawRole as AuditActorRole)
    : "";
  return {
    actorId: params.get("actorId") ?? "",
    action: params.get("action") ?? "",
    role,
    targetId: params.get("targetId") ?? "",
    q: params.get("q") ?? "",
    startDate: params.get("startDate") ?? "",
    endDate: params.get("endDate") ?? "",
  };
}

function buildUrlSearchParams(filters: AuditFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.actorId.trim()) params.set("actorId", filters.actorId.trim());
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.role) params.set("role", filters.role);
  if (filters.targetId.trim()) params.set("targetId", filters.targetId.trim());
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  return params;
}

function normalizeStartDate(value: string): string {
  if (!value) return "";
  return value.includes("T") ? value : `${value}T00:00:00.000Z`;
}

function normalizeEndDate(value: string): string {
  if (!value) return "";
  return value.includes("T") ? value : `${value}T23:59:59.999Z`;
}

function buildApiQueryParams(
  filters: AuditFilterState,
  extra?: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.actorId.trim()) params.set("actorId", filters.actorId.trim());
  if (filters.action.trim()) params.set("action", filters.action.trim());
  if (filters.role) params.set("role", filters.role);
  if (filters.targetId.trim()) params.set("targetId", filters.targetId.trim());
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.startDate) params.set("startDate", normalizeStartDate(filters.startDate));
  if (filters.endDate) params.set("endDate", normalizeEndDate(filters.endDate));
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value) params.set(key, value);
    }
  }
  return params;
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function extractErrorMessage(
  response: Response,
  fallback: string,
): Promise<{ code?: string; message: string }> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    if (body?.error?.message) {
      return { code: body.error.code, message: body.error.message };
    }
  } catch {
    // Ignore non-JSON error responses.
  }
  return { message: fallback };
}

export default function AuditPage() {
  const [filters, setFilters] = useState<AuditFilterState>(() =>
    typeof window !== "undefined"
      ? parseFiltersFromSearch(window.location.search)
      : EMPTY_FILTERS,
  );
  const [resetKey, setResetKey] = useState(0);

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [hasNext, setHasNext] = useState<boolean>(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [chainIntact, setChainIntact] = useState<boolean>(true);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLoadingMore, setIsLoadingMore] = useState<boolean>(false);
  const [isForbidden, setIsForbidden] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isDownloadingArchive, setIsDownloadingArchive] = useState<boolean>(false);

  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [liveMessage, setLiveMessage] = useState<string>("");

  const abortControllerRef = useRef<AbortController | null>(null);

  const syncUrl = useCallback((nextFilters: AuditFilterState) => {
    if (typeof window === "undefined") return;
    const params = buildUrlSearchParams(nextFilters);
    const qs = params.toString();
    const nextUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", nextUrl);
  }, []);

  const fetchAuditEntries = useCallback(
    async (
      activeFilters: AuditFilterState,
      options: { cursor?: string | null; append?: boolean } = {},
    ) => {
      const { cursor = null, append = false } = options;

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
        setErrorMessage(null);
        setIsForbidden(false);
      }

      try {
        const params = buildApiQueryParams(
          activeFilters,
          cursor ? { cursor } : undefined,
        );
        const query = params.toString();
        const url = query ? `/api/audit?${query}` : "/api/audit";

        const response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
        });

        if (response.status === 403 || response.status === 401) {
          setIsForbidden(true);
          setEntries([]);
          setHasNext(false);
          setNextCursor(null);
          setTotal(0);
          setLiveMessage("Access denied. You do not have permission to view audit logs.");
          return;
        }

        if (!response.ok) {
          const err = await extractErrorMessage(
            response,
            `Failed to load audit logs (HTTP ${response.status}).`,
          );
          const message =
            err.code === "INVALID_CURSOR"
              ? `Invalid pagination cursor: ${err.message}`
              : err.message;
          setErrorMessage(message);
          setLiveMessage(`Error: ${message}`);
          return;
        }

        const payload = (await response.json()) as AuditResponseDTO;
        setChainIntact(payload.meta.chainIntact);
        setRetentionDays(payload.meta.retentionDays);
        setTotal(payload.meta.total);
        setHasNext(payload.meta.hasNext);
        setNextCursor(payload.meta.nextCursor);

        if (append) {
          setEntries((prev) => {
            const seen = new Set(prev.map((item) => item.id));
            const uniqueNew = payload.data.filter((item) => !seen.has(item.id));
            const merged = [...prev, ...uniqueNew];
            setLiveMessage(
              `Loaded ${merged.length} of ${payload.meta.total} audit log entries.`,
            );
            return merged;
          });
        } else {
          setEntries(payload.data);
          setLiveMessage(
            payload.data.length === 0
              ? "No audit log entries match the current filters."
              : `Showing ${payload.data.length} of ${payload.meta.total} audit log entries.`,
          );
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          return;
        }
        const message = "Unable to load audit logs. Please try again.";
        setErrorMessage(message);
        setLiveMessage(`Error: ${message}`);
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    syncUrl(filters);
    void fetchAuditEntries(filters);
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [filters, syncUrl, fetchAuditEntries]);

  const updateFilter = <K extends keyof AuditFilterState>(
    key: K,
    value: AuditFilterState[K],
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleResetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setResetKey((k) => k + 1);
    setActionError(null);
  };

  const handleLoadMore = () => {
    if (!hasNext || !nextCursor || isLoadingMore) return;
    void fetchAuditEntries(filters, { cursor: nextCursor, append: true });
  };

  const toggleMetadata = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleExportCsv = async () => {
    setActionError(null);
    setIsExporting(true);
    try {
      const params = buildApiQueryParams(filters, { format: "csv" });
      const response = await fetch(`/api/audit/export?${params.toString()}`, {
        method: "GET",
      });

      if (response.status === 403 || response.status === 401) {
        setActionError(
          "Export forbidden: admin, security, or compliance role is required to export audit logs.",
        );
        return;
      }

      if (!response.ok) {
        const err = await extractErrorMessage(
          response,
          `CSV export failed (HTTP ${response.status}).`,
        );
        setActionError(err.message);
        return;
      }

      const blob = await response.blob();
      triggerBlobDownload(blob, "audit-log-export.csv");
    } catch {
      setActionError("CSV export failed due to a network error.");
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadArchive = async () => {
    setActionError(null);
    setIsDownloadingArchive(true);
    try {
      const response = await fetch("/api/audit/archive", {
        method: "GET",
      });

      if (response.status === 403 || response.status === 401) {
        setActionError(
          "Archive download forbidden: admin, security, or compliance role is required.",
        );
        return;
      }

      if (!response.ok) {
        const err = await extractErrorMessage(
          response,
          `Archive download failed (HTTP ${response.status}).`,
        );
        setActionError(err.message);
        return;
      }

      const blob = await response.blob();
      triggerBlobDownload(blob, "audit-log-archive.ndjson");
    } catch {
      setActionError("Archive download failed due to a network error.");
    } finally {
      setIsDownloadingArchive(false);
    }
  };

  if (isForbidden) {
    return (
      <main className="page-shell mx-auto max-w-6xl px-4 py-8">
        <LiveRegion message={liveMessage} />
        <section
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 p-6 text-red-900"
        >
          <h1 className="text-xl font-semibold">Audit Log Access Restricted</h1>
          <p className="mt-2 text-sm">
            You do not have the required role to view audit logs. Access is
            restricted to support, finance, admin, security, and compliance
            staff.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell mx-auto max-w-7xl px-4 py-6">
      <LiveRegion message={liveMessage} />

      {!chainIntact && (
        <div
          role="alert"
          data-testid="chain-integrity-banner"
          className="mb-4 rounded-lg border-2 border-red-600 bg-red-50 p-4 text-red-900"
        >
          <p className="font-semibold">
            Audit chain integrity check failed
          </p>
          <p className="mt-1 text-sm">
            The tamper-evident hash chain is broken (chainIntact: false).
            Escalate to security and compliance immediately.
          </p>
        </div>
      )}

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audit Log</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Inspect tamper-evident security and compliance events.
            {retentionDays !== null ? ` Retention window: ${retentionDays} days.` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={isExporting}
            className="rounded border px-3 py-2 text-sm font-medium"
          >
            {isExporting ? "Exporting CSV..." : "Export CSV"}
          </button>
          <button
            type="button"
            onClick={handleDownloadArchive}
            disabled={isDownloadingArchive}
            className="rounded border px-3 py-2 text-sm font-medium"
          >
            {isDownloadingArchive ? "Downloading archive..." : "Download archive"}
          </button>
        </div>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"
        >
          {actionError}
        </div>
      )}

      <section
        aria-label="Audit log filters"
        className="mb-6 rounded-lg border p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-sm font-medium">
            Actor ID
            <input
              type="text"
              value={filters.actorId}
              onChange={(e) => updateFilter("actorId", e.target.value)}
              placeholder="e.g. ops-admin-42"
              className="rounded border px-2 py-1 text-sm font-normal"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Action
            <input
              type="text"
              value={filters.action}
              onChange={(e) => updateFilter("action", e.target.value)}
              placeholder="e.g. stream.settle"
              className="rounded border px-2 py-1 text-sm font-normal"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Role
            <select
              value={filters.role}
              onChange={(e) =>
                updateFilter("role", e.target.value as AuditActorRole | "")
              }
              className="rounded border px-2 py-1 text-sm font-normal"
            >
              <option value="">All roles</option>
              {AUDIT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Target ID
            <input
              type="text"
              value={filters.targetId}
              onChange={(e) => updateFilter("targetId", e.target.value)}
              placeholder="e.g. stream-ada"
              className="rounded border px-2 py-1 text-sm font-normal"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Search
            <input
              type="search"
              value={filters.q}
              onChange={(e) => updateFilter("q", e.target.value)}
              placeholder="Free-text search"
              className="rounded border px-2 py-1 text-sm font-normal"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <DateRangePicker
            key={resetKey}
            startDate={filters.startDate}
            endDate={filters.endDate}
            label="Date range"
            onChange={({ startDate, endDate }) =>
              setFilters((prev) => ({ ...prev, startDate, endDate }))
            }
          />

          <button
            type="button"
            onClick={handleResetFilters}
            className="rounded border px-3 py-2 text-sm font-medium"
          >
            Reset filters
          </button>
        </div>
      </section>

      {errorMessage && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => void fetchAuditEntries(filters)}
            className="rounded border border-red-400 px-3 py-1 font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading ? (
        <div role="status" className="rounded-lg border p-8 text-center text-sm">
          Loading audit logs...
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border p-8 text-center text-sm text-zinc-600">
          No audit log entries found for the selected filters.
        </div>
      ) : (
        <section aria-label="Audit log results">
          <p className="mb-2 text-xs text-zinc-600">
            Showing {entries.length} of {total} entries
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b bg-zinc-50">
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Actor</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">Target</th>
                  <th className="px-3 py-2 font-semibold">Request ID</th>
                  <th className="px-3 py-2 font-semibold">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const isExpanded = Boolean(expandedIds[entry.id]);
                  const hasMetadata =
                    entry.metadata && Object.keys(entry.metadata).length > 0;
                  return (
                    <React.Fragment key={entry.id}>
                      <tr className="border-b align-top">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                          {entry.timestamp}
                        </td>
                        <td className="px-3 py-2">{entry.actor.id}</td>
                        <td className="px-3 py-2">{entry.actor.role}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {entry.action}
                        </td>
                        <td className="px-3 py-2">
                          {entry.target.type}:{entry.target.id}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {entry.requestId}
                        </td>
                        <td className="px-3 py-2">
                          {hasMetadata ? (
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() => toggleMetadata(entry.id)}
                              className="rounded border px-2 py-1 text-xs"
                            >
                              {isExpanded ? "Hide JSON" : "View JSON"}
                            </button>
                          ) : (
                            <span className="text-xs text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasMetadata && (
                        <tr className="border-b bg-zinc-50">
                          <td colSpan={7} className="px-3 py-2">
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border bg-white p-3 font-mono text-xs">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasNext && nextCursor && (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="rounded border px-4 py-2 text-sm font-medium"
              >
                {isLoadingMore ? "Loading more..." : "Load more"}
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
