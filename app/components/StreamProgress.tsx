/**
 * StreamProgress
 *
 * Slim burn-down progress bar for a payment stream.
 *
 * ## Visual behaviour by status
 * - active  → filled bar (accrued %) + remaining-balance label; animates on
 *             load unless the user prefers reduced motion.
 * - paused  → same as active but uses the paused color token; no animation.
 * - draft   → empty bar (0 %) with "Not started" label.
 * - ended / withdrawn / cancelled → full bar (100 %) with "Completed" label.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - role="progressbar" with aria-valuenow, aria-valuemin, aria-valuemax.
 * - aria-valuetext provides a human-readable description so screen readers
 *   do not just announce a raw percentage.
 * - State is NOT conveyed by color alone — the percentage label is always
 *   visible alongside the bar.
 * - The track is keyboard-focusable (tabIndex 0) so keyboard-only users can
 *   reach it in tab order and hear its current value; a visible focus-visible
 *   outline (see `app/styles/focus.css`) marks it while focused via keyboard,
 *   and stays hidden for mouse/touch interaction.
 * - Aria-live region announces status transitions (active, paused, ended, etc.)
 *   and progress milestones (every 10 %) to assistive technologies.
 *
 * ## Amounts
 * Accepts raw i128-compatible bigint or number values. No decimal conversion
 * is performed here; callers supply pre-scaled display values if needed.
 *
 * ## Styling
 * Track/meta spacing and label typography (`app/globals.css`, the
 * `.stream-progress*` rules) are pinned to the shared `--space-*` / `--text-*`
 * / `--font-*` design tokens rather than hardcoded rem values, so the
 * component stays in step with any future scale adjustments.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamStatus } from "@/app/types/openapi";
import { LiveRegion } from "./LiveRegion";
import { EmptyState } from "./EmptyState";
import { KbdHint } from "@/src/components/KbdHint";
import type { KbdShortcut } from "@/src/components/KbdHint";
import { Skeleton } from "./Skeleton";

// ── Reduced-motion ─────────────────────────────────────────────────────────────

/**
 * Tracks the user's `prefers-reduced-motion` setting.
 *
 * Reads the media query synchronously on mount so the correct class is applied
 * on the first render (no flash). Updates live if the preference changes.
 * SSR-safe: returns `false` on the server.
 */
function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }

    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return prefersReduced;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamProgressProps {
  status: StreamStatus | "empty";
  /**
   * Amount already accrued / vested (raw units or display units — must be
   * consistent with `totalAmount`).
   */
  accruedAmount?: number;
  /**
   * Total stream amount (raw units or display units).
   * When omitted the component falls back to schedule-based elapsed ratio.
   */
  totalAmount?: number;
  /**
   * Stream start ISO-8601 timestamp. Used for elapsed-time fallback when
   * `accruedAmount` / `totalAmount` are not provided.
   */
  startedAt?: string;
  /**
   * Stream end / expected-end ISO-8601 timestamp. Used for elapsed-time
   * fallback.
   */
  endsAt?: string;
  /** Optional CSS class forwarded to the wrapper element. */
  className?: string;
  /** Optional flag to force the empty state visual. */
  isEmpty?: boolean;
  /** Optional custom copy eyebrow for the empty state */
  emptyEyebrow?: string;
  /** Optional custom copy title for the empty state */
  emptyTitle?: string;
  /** Optional custom copy description for the empty state */
  emptyDescription?: string;
  /** Optional custom copy action label for the empty state */
  emptyActionLabel?: string;
  /** Optional handler invoked when the empty state CTA button is pressed */
  onEmptyAction?: () => void;
  /**
   * When true, renders a themed skeleton placeholder matching the StreamProgress
   * layout — a shimmer track bar and meta row — while stream data is loading.
   * The skeleton is `aria-hidden="true"` for screen readers and wrapped in a
   * `div[aria-busy="true"]`. The container carries `.stream-progress--skeleton`
   * so external CSS or JS can detect the loading state.
   */
  loading?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Clamp a value between 0 and 100 (inclusive).
 */
function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Derive the fill percentage from props.
 *
 * Priority:
 *   1. accruedAmount / totalAmount  (on-chain data — most accurate)
 *   2. elapsed time between startedAt and endsAt  (schedule fallback)
 *   3. Status-based default (draft → 0, ended/withdrawn/cancelled → 100)
 */
function derivePercent(props: StreamProgressProps): number {
  const { status, accruedAmount, totalAmount, startedAt, endsAt } = props;

  // Terminal states
  if (status === "ended" || status === "withdrawn" || status === "cancelled") {
    return 100;
  }
  if (status === "draft") {
    return 0;
  }

  // On-chain amounts (active / paused)
  if (
    typeof accruedAmount === "number" &&
    typeof totalAmount === "number" &&
    totalAmount > 0
  ) {
    return clamp((accruedAmount / totalAmount) * 100);
  }

  // Schedule-based elapsed time fallback
  if (startedAt && endsAt) {
    const start = new Date(startedAt).getTime();
    const end   = new Date(endsAt).getTime();
    const now   = Date.now();
    const total = end - start;
    if (total > 0) {
      return clamp(((now - start) / total) * 100);
    }
  }

  // Unknown — show indeterminate 50 % for active, 0 for paused
  return status === "active" ? 50 : 0;
}

/**
 * Human-readable label for aria-valuetext and the visible percentage.
 */
function deriveLabel(status: StreamStatus | "empty", percent: number): string {
  if (status === "draft")      return "Not started";
  if (status === "ended")      return "Completed";
  if (status === "withdrawn")  return "Withdrawn";
  if (status === "cancelled")  return "Cancelled";
  if (status === "empty")      return "No stream";
  return `${Math.round(percent)}% accrued`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StreamProgress({
  status,
  accruedAmount,
  totalAmount,
  startedAt,
  endsAt,
  className = "",
  isEmpty = false,
  emptyEyebrow,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  loading = false,
}: StreamProgressProps) {
  // ── Loading skeleton (early return before any hooks) ───────────────────────
  if (loading) {
    return (
      <div
        className={`stream-progress stream-progress--skeleton ${className}`.trim()}
        aria-busy="true"
        aria-label="Stream progress is loading"
      >
        {/* Skeleton track — mirrors .stream-progress__track dimensions */}
        <Skeleton
          className="stream-progress__skeleton-track"
          width="100%"
          height="10px"
        />

        {/* Skeleton meta row — mirrors .stream-progress__meta layout */}
        <div className="stream-progress__skeleton-meta" aria-hidden="true">
          <Skeleton variant="label" width="6rem" />
          <Skeleton variant="text" width="5rem" />
        </div>
      </div>
    );
  }

  const percent = derivePercent({ status, accruedAmount, totalAmount, startedAt, endsAt });
  const label   = deriveLabel(status, percent);
  const prefersReducedMotion = usePrefersReducedMotion();

  // ── Keyboard shortcut hints ────────────────────────────────────────────────
  const [showHints, setShowHints] = useState(false);
  const toggleHints = useCallback(() => setShowHints((prev) => !prev), []);

  const shortcuts: KbdShortcut[] = [];
  if (status === "active" || status === "paused") {
    shortcuts.push({ keys: ["Space"], description: "Pause / resume" });
  }
  if (status === "draft") {
    shortcuts.push({ keys: ["Enter"], description: "Start stream" });
  }
  shortcuts.push({ keys: ["Esc"], description: "Deselect" });
  shortcuts.push({ keys: ["Ctrl", "K"], description: "Command palette" });

  // ── ARIA live announcements ────────────────────────────────────────────────
  const [srAnnouncement, setSrAnnouncement] = useState("");
  const prevStatusRef = useRef<StreamStatus | null>(null);
  const prevPercentRef = useRef<number | null>(null);

  useEffect(() => {
    const prevStatus  = prevStatusRef.current;
    const prevPercent = prevPercentRef.current;

    // First render — seed refs without announcing.
    if (prevStatus === null) {
      prevStatusRef.current  = status;
      prevPercentRef.current = percent;
      return;
    }

    // Status changed — announce the transition.
    if (prevStatus !== status) {
      if (status === "ended") {
        setSrAnnouncement("Stream completed");
      } else if (status === "withdrawn") {
        setSrAnnouncement("Stream withdrawn");
      } else if (status === "cancelled") {
        setSrAnnouncement("Stream cancelled");
      } else if (status === "paused") {
        setSrAnnouncement("Stream paused");
      } else if (status === "active") {
        setSrAnnouncement("Stream resumed");
      } else if (status === "draft") {
        setSrAnnouncement("Stream draft created");
      }
      prevStatusRef.current  = status;
      prevPercentRef.current = percent;
      return;
    }

    // Percent changed by ≥ 10 % — announce progress milestone.
    if (
      prevPercent !== null &&
      Math.abs(percent - prevPercent) >= 10
    ) {
      setSrAnnouncement(`Stream progress: ${Math.round(percent)}% accrued`);
      prevPercentRef.current = percent;
    }
  }, [status, percent]);

  // Map status to BEM modifier for color tokens
  const modifier =
    status === "active"    ? "active"    :
    status === "paused"    ? "paused"    :
    status === "ended" || status === "withdrawn" ? "ended" :
    status === "cancelled" ? "cancelled" :
    "draft";

  // When the user prefers reduced motion we render a static bar: the fill is
  // positioned instantly with no width transition. This is also exposed as a
  // modifier class so external CSS can opt out of any keyframe animations.
  const motionModifier = prefersReducedMotion ? "static" : "animated";

  // Return empty state if status is "empty" or isEmpty is explicitly true
  if (status === "empty" || isEmpty) {
    return (
      <EmptyState
        eyebrow={emptyEyebrow ?? "Stream Progress"}
        title={emptyTitle ?? "No active stream found"}
        description={
          emptyDescription ??
          "There is no stream progress to track. Start a stream to see live accumulation."
        }
        actionLabel={emptyActionLabel ?? "Start a stream"}
        onAction={onEmptyAction}
        variant="stream-progress"
        className={className}
      />
    );
  }

  return (
    <div
      className={`stream-progress stream-progress--${motionModifier} ${className}`.trim()}
      data-reduced-motion={prefersReducedMotion ? "true" : "false"}
    >
      {/* Screen-reader live announcements for status / progress changes */}
      <LiveRegion message={srAnnouncement} data-testid="stream-progress-live" />

      {/* Track */}
      <div
        role="progressbar"
        tabIndex={0}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={label}
        aria-label={`Stream progress: ${label}`}
        className={`stream-progress__track stream-progress__track--${modifier}`}
      >
        {/* Fill — transitions width unless reduced motion is requested. */}
        <div
          className={`stream-progress__fill stream-progress__fill--${modifier} cb-pattern cb-pattern--${modifier}`}
          style={{
            width: `${percent}%`,
            transition: prefersReducedMotion ? "none" : "width 400ms ease",
          }}
        />
      </div>

      {/* Visible label — state is NOT conveyed by color alone */}
      <div className="stream-progress__meta" aria-hidden="true">
        <span className="stream-progress__label tabular-nums">{label}</span>
        {typeof totalAmount === "number" && typeof accruedAmount === "number" && totalAmount > 0 && (
          <span className="stream-progress__remaining tabular-nums">
            {Math.round(totalAmount - accruedAmount).toLocaleString()} remaining
          </span>
        )}
      </div>

      {/* Keyboard shortcut hints — hidden by default, toggled via button */}
      <div className="stream-progress__hints" aria-hidden="true">
        <button
          type="button"
          className="stream-progress__hints-toggle"
          onClick={toggleHints}
          aria-expanded={showHints}
          data-testid="stream-progress-kbd-toggle"
        >
          <span className="stream-progress__hints-icon" aria-hidden="true">
            {showHints ? "▾" : "▸"}
          </span>
          Keyboard shortcuts
        </button>
        {showHints && (
          <KbdHint
            shortcuts={shortcuts}
            data-testid="stream-progress-kbd-hints"
          />
        )}
      </div>
    </div>
  );
}
