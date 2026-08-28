"use client";

import React, { useId, useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/app/components/LiveRegion";

/**
 * IndexerStatus
 *
 * Dashboard widget that displays the Stellar Horizon indexer's current
 * synchronisation state. Shows the last ledger processed, the chain tip
 * (latest ledger), and the resulting lag so operators can quickly assess
 * indexer health.
 *
 * ## Behaviour
 * - Controlled component: receives all data via the `data` prop.
 * - Derives a human-readable status label and colour from the numeric lag
 *   and the `status` field.
 * - Shows a relative timestamp for the last cursor update.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - The card is a labelled `<section>` with an `<h2>` heading.
 * - Status is conveyed both visually (icon + colour) and textually.
 * - Numeric values use `aria-label` for screen-reader context.
 * - Colour is never the sole indicator of status.
 * - **Live region**: whenever the indexer `status`, `lag`, or `message`
 *   changes an ARIA live announcement is made so assistive technologies
 *   pick up the update without requiring the user to move focus.
 *   - Non-error transitions use `"polite"` politeness (reads after the
 *     current utterance finishes).
 *   - Error and stalled states use `"assertive"` politeness (interrupts
 *     immediately) so critical failures are never missed.
 * - The status indicator `<div>` carries a full `aria-label` combining the
 *   label and severity so screen-reader users get both in a single phrase.
 *
 * ## Theming
 * Uses design tokens (`--card-surface`, `--border`, `--accent`, …) so it is
 * consistent in both light and dark mode.
 */

export type IndexerState = "loading" | "synced" | "syncing" | "stalled" | "stopped" | "error" | "retrying";

export interface IndexerStatusData {
  /** Network label, e.g. "testnet" or "mainnet". */
  network: string;
  /** The most recently processed ledger sequence number. */
  lastProcessedLedger: number;
  /** The latest known ledger sequence on the Horizon network. */
  latestLedger: number;
  /**
   * High-level indexer health.
   * - `loading`: the indexer has started but has not processed a ledger yet.
   * - `synced`: lag is within tolerance (≤ 2 ledgers).
   * - `syncing`: lag is noticeable but the indexer is running.
   * - `stalled`: cursor has not advanced within the stall threshold.
   * - `retrying`: a transient error occurred and a backoff retry is pending.
   * - `stopped`: the indexer main loop is not running.
   * - `error`: a fatal error has been reported.
   */
  status: IndexerState;
  /** ISO 8601 timestamp of the last cursor update. */
  lastUpdatedAt: string;
  /** Indexer lag: `latestLedger - lastProcessedLedger`. */
  lag: number;
  /**
   * Optional human-readable detail (e.g. "cursor is stale", "circuit breaker
   * is open"). Rendered when supplied so failures are diagnosable without
   * exposing raw sensitive state.
   */
  message?: string;
}

export interface IndexerStatusProps {
  /** Current indexer state snapshot. */
  data: IndexerStatusData;
  /** Optional CSS class name forwarded to the root element. */
  className?: string;
}

/**
 * Format a relative timestamp like "2m ago" or "just now".
 * Falls back to the raw ISO string if parsing fails.
 */
function relativeTime(iso: string, now: Date = new Date()): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return iso;

  const diffMs = now.getTime() - target.getTime();
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format a ledger number with locale-aware separators. */
function formatLedger(n: number): string {
  return n.toLocaleString();
}

function statusLabel(state: IndexerState): string {
  switch (state) {
    case "loading":
      return "Loading";
    case "synced":
      return "Synced";
    case "syncing":
      return "Syncing";
    case "stalled":
      return "Stalled";
    case "retrying":
      return "Retrying";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
  }
}

/** Severity level derived from the indexer state for colour-coding. */
function severity(
  state: IndexerState,
  lag: number,
): "success" | "warning" | "error" | "info" {
  if (state === "error" || state === "stalled") return "error";
  if (state === "retrying" || state === "stopped") return "warning";
  if (state === "loading") return "info";
  if (state === "syncing" || lag > 5) return "warning";
  return "success";
}

/**
 * Build the announcement string for a status update.
 *
 * This string is placed into the ARIA live region so screen readers announce
 * the new state without requiring a focus change.  It is intentionally
 * concise — assistive technology users do not want verbose paragraphs here.
 *
 * @internal exported for testing only
 */
export function buildAnnouncement(
  state: IndexerState,
  lag: number,
  message?: string,
): string {
  const label = statusLabel(state);
  const lagPart = lag > 0 ? `, lag ${lag} ledger${lag === 1 ? "" : "s"}` : "";
  const messagePart = message ? `. ${message}` : "";
  return `Indexer status: ${label}${lagPart}${messagePart}.`;
}

/**
 * Whether this state warrants an assertive (interrupting) announcement.
 * Critical failures should be announced immediately regardless of what the
 * screen reader is currently reading.
 *
 * @internal exported for testing only
 */
export function isAssertiveState(state: IndexerState): boolean {
  return state === "error" || state === "stalled";
}

export function IndexerStatus({ data, className = "" }: IndexerStatusProps) {
  const headingId = useId();
  const { network, lastProcessedLedger, latestLedger, status, lastUpdatedAt, lag, message } = data;
  const sev = severity(status, lag);
  const label = statusLabel(status);

  // ── Accessibility: live-region announcement ────────────────────────────────
  // We announce status transitions to screen readers via an ARIA live region.
  //
  // Design decisions:
  //   1. The live region is only updated when status, lag, or message actually
  //      changes — not on every render — to avoid spamming the screen reader
  //      with identical announcements on unrelated re-renders.
  //   2. We skip the very first render (mount) because the card content is
  //      already visible/focusable at that point; an immediate announcement
  //      would race with the user's current reading position.
  //   3. We use two separate LiveRegion elements — one polite and one
  //      assertive — so we can swap between politeness levels without
  //      unmounting the DOM node.  Unmounting and remounting a live region
  //      causes some screen readers (NVDA, VoiceOver) to miss the first
  //      announcement because they re-register the region before the text
  //      updates.  Having both nodes always present and routing the message to
  //      the correct one avoids this pitfall.
  const [announcement, setAnnouncement] = useState<{
    text: string;
    assertive: boolean;
  }>({ text: "", assertive: false });

  const prevStatusRef = useRef<IndexerState | null>(null);
  const prevLagRef = useRef<number | null>(null);
  const prevMessageRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const isFirstRender =
      prevStatusRef.current === null &&
      prevLagRef.current === null;

    const statusChanged = prevStatusRef.current !== status;
    // Only announce lag changes when the lag moves between meaningful buckets
    // (ok ≤ 2, warning ≤ 10, high > 10) to avoid flooding the user with
    // per-ledger noise on every tick.
    const prevLagBucket = lagBucket(prevLagRef.current ?? lag);
    const nextLagBucket = lagBucket(lag);
    const lagChanged = prevLagBucket !== nextLagBucket;
    const messageChanged = prevMessageRef.current !== message;

    prevStatusRef.current = status;
    prevLagRef.current = lag;
    prevMessageRef.current = message;

    if (isFirstRender) {
      // Skip the initial mount — the card content is visible; no announcement
      // needed before the user has had a chance to navigate to it.
      return;
    }

    if (statusChanged || lagChanged || messageChanged) {
      setAnnouncement({
        text: buildAnnouncement(status, lag, message),
        assertive: isAssertiveState(status),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lag, message]);

  return (
    <section
      className={`indexer-status indexer-status--${sev} ${className}`}
      aria-labelledby={headingId}
    >
      {/*
        Live-region pair: always-present in the DOM so screen readers register
        them on mount. We route the announcement to either the polite or the
        assertive node depending on severity.  The inactive node always has an
        empty message so it never fires spurious announcements.
      */}
      <LiveRegion
        message={announcement.assertive ? "" : announcement.text}
        politeness="polite"
        data-testid="indexer-live-region-polite"
      />
      <LiveRegion
        message={announcement.assertive ? announcement.text : ""}
        politeness="assertive"
        data-testid="indexer-live-region-assertive"
      />

      <div className="indexer-status__header">
        <h2 id={headingId} className="indexer-status__title">
          Indexer Status
        </h2>
        <span className="indexer-status__network">{network}</span>
      </div>

      <div className="indexer-status__body">
        <dl className="indexer-status__stats">
          <div className="indexer-status__stat">
            <dt>Last Processed</dt>
            <dd aria-label={`Last processed ledger ${lastProcessedLedger}`}>
              {formatLedger(lastProcessedLedger)}
            </dd>
          </div>

          <div className="indexer-status__stat">
            <dt>Latest Ledger</dt>
            <dd aria-label={`Latest ledger ${latestLedger}`}>
              {formatLedger(latestLedger)}
            </dd>
          </div>

          <div className="indexer-status__stat">
            <dt>Lag</dt>
            <dd
              className="indexer-status__lag-value"
              aria-label={`Lag ${lag} ledgers`}
            >
              {lag > 999
                ? `${(lag / 1000).toFixed(1)}k`
                : formatLedger(lag)}{" "}
              <span className="indexer-status__lag-unit">ledgers</span>
            </dd>
          </div>
        </dl>

        <div className="indexer-status__footer">
          {/*
            The status indicator carries a full descriptive aria-label so screen
            readers announce "Status: Synced" rather than just the raw label.
            The decorative dot is hidden from assistive tech (aria-hidden).
          */}
          <div
            className="indexer-status__status-indicator"
            aria-label={`Status: ${label}`}
          >
            <span
              className="indexer-status__dot"
              aria-hidden="true"
            />
            <span className="indexer-status__status-label" aria-hidden="true">{label}</span>
          </div>

          <span className="indexer-status__timestamp">
            updated {relativeTime(lastUpdatedAt)}
          </span>
        </div>

        {message ? (
          <p className="indexer-status__message" role="status">
            {message}
          </p>
        ) : null}
      </div>

      <style jsx>{`
        .indexer-status {
          display: grid;
          gap: 0.75rem;
          padding: 1.25rem;
          background: var(--card-surface);
          border: 1px solid var(--card-border);
          border-radius: 1rem;
          width: 100%;
          max-width: 28rem;
        }

        .indexer-status__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .indexer-status__title {
          font-size: 1.05rem;
          margin: 0;
        }

        .indexer-status__network {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--accent);
        }

        .indexer-status__body {
          display: grid;
          gap: 1rem;
        }

        .indexer-status__stats {
          display: grid;
          gap: 0.5rem;
          margin: 0;
        }

        .indexer-status__stat {
          display: flex;
          align-items: center;
          justify-content: space-between;
          min-height: 2rem;
        }

        .indexer-status__stat dt {
          font-size: 0.8125rem;
          color: var(--muted);
          font-weight: 600;
        }

        .indexer-status__stat dd {
          font-size: 0.9375rem;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          font-family: ui-monospace, "Cascadia Code", "Fira Mono", monospace;
          margin: 0;
        }

        .indexer-status__lag-value {
          color: var(--status-color, var(--foreground));
        }

        .indexer-status__lag-unit {
          font-size: 0.75rem;
          font-weight: 500;
          color: var(--muted);
          font-family: inherit;
        }

        .indexer-status__footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 0.5rem;
          padding-top: 0.75rem;
          border-top: 1px solid var(--card-border);
        }

        .indexer-status__status-indicator {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
        }

        .indexer-status__dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: var(--status-color, var(--muted));
          flex-shrink: 0;
        }

        .indexer-status__status-label {
          font-size: 0.8125rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--status-color, var(--foreground));
        }

        .indexer-status__timestamp {
          font-size: 0.75rem;
          color: var(--muted);
        }

        .indexer-status__message {
          margin: 0;
          padding-top: 0.5rem;
          border-top: 1px solid var(--card-border);
          font-size: 0.8125rem;
          color: var(--muted);
        }

        /* ── Severity variants ── */
        .indexer-status--success {
          --status-color: var(--accent);
          --card-surface: var(--system-success-bg, transparent);
          --card-border: var(--system-success-border, var(--border));
        }

        .indexer-status--warning {
          --status-color: #eab308;
          --card-surface: var(--system-warning-bg, transparent);
          --card-border: var(--system-warning-border, #eab308);
        }

        .indexer-status--error {
          --status-color: var(--system-error-text, #ef4444);
          --card-surface: var(--system-error-bg, transparent);
          --card-border: var(--system-error-border, #ef4444);
        }

        .indexer-status--info {
          --status-color: var(--muted-light);
          --card-surface: transparent;
          --card-border: var(--border);
        }

        /* ── Responsive ── */
        @media (min-width: 30rem) {
          .indexer-status {
            max-width: 28rem;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .indexer-status__dot {
            transition: none;
          }
        }
      `}</style>
    </section>
  );
}

/**
 * Bucket a lag value into a named severity tier.
 * Used to decide when lag changes are significant enough to announce.
 *
 * | Bucket    | Lag range   |
 * |-----------|-------------|
 * | `"ok"`    | 0 – 2       |
 * | `"warn"`  | 3 – 10      |
 * | `"high"`  | > 10        |
 *
 * @internal exported for testing only
 */
export function lagBucket(lag: number): "ok" | "warn" | "high" {
  if (lag <= 2) return "ok";
  if (lag <= 10) return "warn";
  return "high";
}

export default IndexerStatus;
