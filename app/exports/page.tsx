"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ExportJob, ExportJobStatus } from "@/app/types/openapi";
import { DateRangePicker } from "../components/DateRangePicker";
import { Timestamp } from "../components/Timestamp";
import { useExportJobs, type ExportFormat } from "./useExportJobs";

const exportStatusCopy: Record<ExportJobStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
};

const exportStatusGlyph: Record<ExportJobStatus, string> = {
  pending: "○",
  ready: "▶",
  failed: "✕",
  expired: "■",
};

const exportStatusModifier: Record<ExportJobStatus, string> = {
  pending: "paused",
  ready: "active",
  failed: "cancelled",
  expired: "ended",
};

const exportStatusPattern: Record<ExportJobStatus, string> = {
  pending: "cb-pattern--paused",
  ready: "cb-pattern--active",
  failed: "cb-pattern--cancelled",
  expired: "cb-pattern--ended",
};

function ExportStatusChip({ status }: { status: ExportJobStatus }) {
  const label = exportStatusCopy[status];
  const modifier = exportStatusModifier[status];
  const patternClass = exportStatusPattern[status];

  return (
    <span
      aria-label={`Export status: ${label}`}
      className={[
        "status-badge",
        `status-badge--${modifier}`,
        "cb-pattern",
        patternClass,
      ].join(" ")}
    >
      <span className={`status-icon status-icon--${status}`} aria-hidden="true">
        {exportStatusGlyph[status]}
      </span>
      {label}
    </span>
  );
}

function getEffectiveStatus(job: ExportJob, nowMs: number): ExportJobStatus {
  if (job.status === "expired") return "expired";
  const expiresMs = Date.parse(job.expiresAt);
  if (!Number.isNaN(expiresMs) && expiresMs <= nowMs) {
    return "expired";
  }
  return job.status;
}

function toIsoStartOfDay(dateStr: string): string {
  return `${dateStr}T00:00:00.000Z`;
}

function toIsoEndOfDay(dateStr: string): string {
  return `${dateStr}T23:59:59.999Z`;
}

export function ExportsPageContent() {
  const {
    jobs,
    isLoading,
    isSubmitting,
    error,
    submitError,
    rateLimitSecondsLeft,
    isRateLimited,
    requestExport,
    retryExport,
  } = useExportJobs();

  const [format, setFormat] = useState<ExportFormat>("csv");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Schedule a single timer for the soonest upcoming job expiry so jobs
  // transition to "Expired" while the page stays open without leaking timers.
  const nextExpiryMs = useMemo(() => {
    let earliest: number | null = null;
    for (const job of jobs) {
      if (job.status === "expired") continue;
      const ms = Date.parse(job.expiresAt);
      if (!Number.isNaN(ms) && ms > nowMs) {
        if (earliest === null || ms < earliest) {
          earliest = ms;
        }
      }
    }
    return earliest;
  }, [jobs, nowMs]);

  useEffect(() => {
    if (nextExpiryMs === null) return;
    const delay = Math.max(0, nextExpiryMs - Date.now()) + 10;
    const timer = setTimeout(() => {
      setNowMs(Date.now());
    }, delay);
    return () => clearTimeout(timer);
  }, [nextExpiryMs]);

  const handleDateRangeChange = (range: { startDate: string; endDate: string }) => {
    setStartDate(range.startDate);
    setEndDate(range.endDate);
    if (range.startDate && range.endDate && range.startDate > range.endDate) {
      setValidationError("Start date must be on or before end date.");
    } else {
      setValidationError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (startDate && endDate && startDate > endDate) {
      setValidationError("Start date must be on or before end date.");
      return;
    }
    setValidationError(null);

    await requestExport({
      format,
      startDate: startDate ? toIsoStartOfDay(startDate) : undefined,
      endDate: endDate ? toIsoEndOfDay(endDate) : undefined,
    });
  };

  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">Data Management</p>
          <h1 className="page-hero__title">Data Exports</h1>
          <p className="page-hero__description">
            Request CSV or JSON exports of your streams and activity, track job
            progress, and download ready files before they expire.
          </p>
          <nav aria-label="Exports navigation">
            <Link href="/settings">Back to Settings</Link>
          </nav>
        </div>
      </header>

      <section aria-labelledby="request-export-heading" className="settings-group">
        <div className="settings-group__header">
          <h2 id="request-export-heading" className="settings-group__title">
            Request an export
          </h2>
          <p className="settings-group__description">
            Choose a file format and an optional date range.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div>
            <label htmlFor="export-format" className="text-sm font-medium">
              Format
              <select
                id="export-format"
                name="format"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                className="ml-2 rounded border px-2 py-1 text-sm"
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
              </select>
            </label>
          </div>

          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onChange={handleDateRangeChange}
            label="Filter date range (optional)"
          />

          {validationError && (
            <p role="alert" style={{ color: "var(--system-error-text)" }}>
              {validationError}
            </p>
          )}

          {submitError && (
            <p role="alert" style={{ color: "var(--system-error-text)" }}>
              {submitError}
            </p>
          )}

          {isRateLimited && (
            <p role="status" aria-live="polite">
              Rate limit active. You can request another export in{" "}
              {rateLimitSecondsLeft}s.
            </p>
          )}

          <div>
            <button
              type="submit"
              className="button button--primary"
              disabled={isSubmitting || isRateLimited}
            >
              {isSubmitting
                ? "Requesting..."
                : isRateLimited
                  ? `Retry in ${rateLimitSecondsLeft}s`
                  : "Request export"}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="export-jobs-heading" className="settings-group">
        <div className="settings-group__header">
          <h2 id="export-jobs-heading" className="settings-group__title">
            Export jobs
          </h2>
        </div>

        {error && (
          <p role="alert" style={{ color: "var(--system-error-text)" }}>
            {error}
          </p>
        )}

        {isLoading ? (
          <p role="status">Loading export jobs...</p>
        ) : jobs.length === 0 ? (
          <p>No export jobs yet. Request an export above to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const effectiveStatus = getEffectiveStatus(job, nowMs);
                  const isExpired = effectiveStatus === "expired";
                  const canDownload =
                    effectiveStatus === "ready" && Boolean(job.signedUrl);
                  const canRetry = effectiveStatus === "failed";

                  return (
                    <tr key={job.id}>
                      <td>{job.fileName}</td>
                      <td>
                        <ExportStatusChip status={effectiveStatus} />
                      </td>
                      <td>
                        <Timestamp iso={job.requestedAt} />
                      </td>
                      <td>
                        {isExpired ? (
                          <span aria-label="Export expired">Expired</span>
                        ) : (
                          <Timestamp iso={job.expiresAt} />
                        )}
                      </td>
                      <td>
                        {canDownload && job.signedUrl && (
                          <a
                            href={job.signedUrl}
                            download={job.fileName}
                            className="button button--secondary"
                          >
                            Download
                          </a>
                        )}
                        {canRetry && (
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => void retryExport(job)}
                            disabled={isSubmitting || isRateLimited}
                          >
                            Retry
                          </button>
                        )}
                        {isExpired && (
                          <span className="text-sm text-zinc-500">
                            Unavailable
                          </span>
                        )}
                        {effectiveStatus === "pending" && (
                          <span className="text-sm text-zinc-500">
                            Processing...
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default function ExportsPage() {
  return <ExportsPageContent />;
}
