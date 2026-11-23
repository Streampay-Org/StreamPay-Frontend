"use client";

import { useState, useRef, useCallback } from "react";
import type { StreamStatus } from "@/app/types/openapi";
import { StatusBadge } from "./StatusBadge";
import { StreamProgress } from "./StreamProgress";
import { MiniBurnDown } from "./MiniBurnDown";
import { RecipientAvatar } from "./RecipientAvatar";
import { ErrorToast } from "./ErrorToast";
import { fetchWithIdempotency } from "../../lib/apiClient";
import { isStreamPayError } from "../lib/errors/mapper";
import { formatErrorForDisplay } from "../lib/errors/handler";
import type { StreamPayError } from "../lib/errors/types";
import { LiveRegion } from "../../src/components/LiveRegion";
import { KbdHint } from "../../src/components/KbdHint";
import { colorFromId } from "../utils/colorFromId";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { Skeleton } from "./Skeleton";

const SWIPE_CANCEL_THRESHOLD = 80;
const SWIPE_CANCEL_MAX = 160;

export type StreamRowData = {
  id: string;
  nextAction: string;
  rate: string;
  recipient: string;
  schedule: string;
  status: StreamStatus;
  /** Amount already accrued (display units). Used by StreamProgress. */
  accruedAmount?: number;
  /** Total stream amount (display units). Used by StreamProgress. */
  totalAmount?: number;
  /** ISO-8601 stream start timestamp. Used by StreamProgress fallback. */
  startedAt?: string;
  /** ISO-8601 expected end timestamp. Used by StreamProgress fallback. */
  endsAt?: string;
  /** Freeform labels shown on the row and used by the tag-chip filter. */
  tags?: string[];
};

type StreamRowProps = {
  stream: StreamRowData;
  density?: "cozy" | "compact";
  /**
   * When true, renders a themed skeleton placeholder matching the StreamRow
   * layout — shimmer blocks for identity, meta, progress bar, and action
   * button — while stream data is loading.
   * The wrapper carries `aria-busy="true"` and skeleton children are
   * `aria-hidden="true"` for screen readers.
   */
  loading?: boolean;
};

/**
 * StreamRow renders a single payment stream card with status, progress,
 * recipient info, action controls, swipe-to-cancel, and a color-blind-safe
 * pattern overlay.
 *
 * Data attributes exposed for e2e / CSS hooks:
 *   - `data-status` — stream lifecycle status (active, draft, paused, etc.)
 *   - `data-reduced-motion` — "true" when the user prefers reduced motion
 *     (Issue #1038); used to gate swipe transitions and animation fallbacks.
 */

export function StreamRow({ stream, density = "cozy", loading = false }: StreamRowProps) {
  // ── Loading skeleton (early return before any hooks) ───────────────────────
  if (loading) {
    const compact = density === "compact";
    return (
      <article
        className={`stream-row stream-row--skeleton ${compact ? "stream-row--compact" : ""}`.trim()}
        aria-busy="true"
        aria-label="Stream row is loading"
      >
        {/* Color stripe placeholder */}
        <div className="stream-row__color-stripe" aria-hidden="true">
          <Skeleton width="4px" height="100%" />
        </div>

        {/* Primary section — identity + badge */}
        <div className="stream-row__primary">
          <div className="stream-row__identity">
            {/* Recipient avatar skeleton */}
            <Skeleton
              width="40px"
              height="40px"
              circle
              aria-hidden="true"
            />
            <div style={{ display: "grid", gap: "0.35rem", flex: 1 }}>
              {/* Recipient name */}
              <Skeleton variant="title" width="65%" />
              {/* Schedule */}
              <Skeleton variant="text" width="40%" />
            </div>
          </div>
          {/* Status badge skeleton */}
          <Skeleton variant="badge" width="5.5rem" height="2rem" />
        </div>

        {/* Meta section — Rate + Status + Burn-down */}
        <div className="stream-row__meta" aria-hidden="true">
          <div>
            <dt>Rate</dt>
            <dd><Skeleton variant="value" width="65%" /></dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd><Skeleton variant="badge" width="50%" height="1.25rem" /></dd>
          </div>
          <div>
            <dt>Burn-down</dt>
            <dd><Skeleton variant="value" width="55%" /></dd>
          </div>
        </div>

        {/* Stream progress skeleton */}
        <div aria-hidden="true" style={{ display: "grid", gap: "0.5rem" }}>
          <Skeleton width="100%" height="10px" />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <Skeleton variant="label" width="4rem" />
            <Skeleton variant="text" width="3rem" />
          </div>
        </div>

        {/* Action button skeleton */}
        <div className="stream-row__action-wrap">
          <Skeleton variant="button" width="7.5rem" height="2.75rem" />
        </div>
      </article>
    );
  }

  const prefersReducedMotion = usePrefersReducedMotion();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<StreamPayError | null>(null);
  const [isIncidentMode] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [srAnnouncement, setSrAnnouncement] = useState("");
  const [swipeOffset, setSwipeOffset] = useState(0);

  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);
  const hasTriggered = useRef(false);

  const canSwipeCancel =
    stream.nextAction.toLowerCase() === "cancel" &&
    stream.status !== "cancelled" &&
    stream.status !== "ended" &&
    stream.status !== "withdrawn";

  const handleDismissError = () => {
    setError(null);
  };

  const handleRetry = async () => {
    if (!error?.retry.retryable) return;
    handleDismissError();
    await handleAction();
  };

  const handleAction = async () => {
    if (isIncidentMode) {
      setErrorMsg(
        "On-chain operations are temporarily paused during incident mode.",
      );
      return;
    }

    setIsProcessing(true);
    setError(null);
    setSrAnnouncement("");

    try {
      const actionRoute = stream.nextAction.toLowerCase();

      await fetchWithIdempotency(`/api/streams/${stream.id}/${actionRoute}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: actionRoute,
        }),
      });

      const successMessage = `${stream.nextAction} operation completed successfully for ${stream.recipient}.`;
      setSrAnnouncement(successMessage);

      setTimeout(() => {
        actionButtonRef.current?.focus();
      }, 0);
    } catch (err: unknown) {
      const streamError = isStreamPayError(err) ? err : null;
      const display = streamError
        ? formatErrorForDisplay(streamError)
        : { message: "Unknown error occurred" };

      if (process.env.NODE_ENV === "development") {
        console.error("Stream action failed:", err);
      }

      setError(streamError);
      setSrAnnouncement(
        `Stream action failed: ${display.message || "Unknown error occurred"}.`,
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!canSwipeCancel) return;
      touchStartX.current = e.touches[0].clientX;
      touchStartY.current = e.touches[0].clientY;
      isSwiping.current = false;
      hasTriggered.current = false;
    },
    [canSwipeCancel],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!canSwipeCancel || hasTriggered.current) return;
      const dx = e.touches[0].clientX - touchStartX.current;
      const dy = e.touches[0].clientY - touchStartY.current;

      if (!isSwiping.current) {
        if (Math.abs(dy) > Math.abs(dx)) return;
        if (dx >= 0) return;
        isSwiping.current = true;
      }

      const offset = Math.min(0, Math.max(-SWIPE_CANCEL_MAX, dx));
      setSwipeOffset(offset);
    },
    [canSwipeCancel],
  );

  const handleTouchEnd = useCallback(() => {
    if (!canSwipeCancel || hasTriggered.current) {
      setSwipeOffset(0);
      return;
    }
    isSwiping.current = false;

    if (swipeOffset < -SWIPE_CANCEL_THRESHOLD) {
      hasTriggered.current = true;
      setSwipeOffset(-SWIPE_CANCEL_MAX);
      handleAction();
    } else {
      setSwipeOffset(0);
    }
  }, [canSwipeCancel, swipeOffset]);

  const swipeStyle =
    canSwipeCancel && swipeOffset !== 0
      ? {
          transform: `translateX(${swipeOffset}px)`,
          transition: prefersReducedMotion ? "none" : undefined,
        }
      : undefined;

  return (
    <article
      className={[
        "stream-row",
        `stream-row--${stream.status}`,
        density === "compact" ? "stream-row--compact" : "",
        canSwipeCancel && swipeOffset < 0 ? "stream-row--swiping" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-status={stream.status}
      data-reduced-motion={prefersReducedMotion ? "true" : "false"}
      aria-labelledby={`${stream.id}-recipient`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={swipeStyle}
    >
      {canSwipeCancel && (
        <div
          className="stream-row__cancel-reveal"
          aria-hidden="true"
          data-swipe-active={swipeOffset < -SWIPE_CANCEL_THRESHOLD}
          data-reduced-motion={prefersReducedMotion ? "true" : "false"}
        >
          <span
            className="stream-row__cancel-label"
            style={{
              transition: prefersReducedMotion ? "none" : undefined,
            }}
          >
            Cancel
          </span>
        </div>
      )}

      <div className="stream-row__pattern" aria-hidden="true" />

      <div
        className="stream-row__color-stripe"
        aria-hidden="true"
        style={{ backgroundColor: colorFromId(stream.id) }}
      />

      <LiveRegion message={srAnnouncement} />

      <div className="stream-row__primary">
        <div className="stream-row__identity">
          <RecipientAvatar recipient={stream.recipient} />
          <div>
            <h2 className="stream-row__recipient" id={`${stream.id}-recipient`}>
              {stream.recipient}
            </h2>
            <p className="stream-row__schedule">{stream.schedule}</p>
          </div>
        </div>
        <StatusBadge status={stream.status} />
      </div>

      <div className="stream-row__meta">
        <div>
          <dt>Rate</dt>
          <dd
            className={`tabular-nums ${
              stream.status === "active" ? "stream-row__accrued--animated" : ""
            }`.trim()}
          >
            {stream.rate}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{stream.status}</dd>
        </div>
        {typeof stream.totalAmount === "number" &&
          typeof stream.accruedAmount === "number" &&
          stream.totalAmount > 0 &&
          stream.status !== "draft" && (
            <div>
              <dt>Burn-down</dt>
              <dd
                className={`stream-row__burndown stream-row__burndown--${stream.status} tabular-nums`}
              >
                <MiniBurnDown
                  totalAmount={stream.totalAmount}
                  accruedAmount={stream.accruedAmount}
                />
              </dd>
            </div>
          )}
      </div>

      {stream.status !== "draft" && (
        <StreamProgress
          status={stream.status}
          accruedAmount={stream.accruedAmount}
          totalAmount={stream.totalAmount}
          startedAt={stream.startedAt}
          endsAt={stream.endsAt}
          className="stream-row__progress"
        />
      )}

      <div className="stream-row__action-wrap">
        <button
          ref={actionButtonRef}
          className={`button button--secondary stream-row__action ${isProcessing ? "button--busy" : ""}`}
          type="button"
          onClick={handleAction}
          disabled={isProcessing || isIncidentMode}
          aria-busy={isProcessing}
          aria-live="assertive"
        >
          {isProcessing ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span>Processing...</span>
            </>
          ) : (
            <span>{stream.nextAction}</span>
          )}
        </button>
        <KbdHint keys={["Enter"]} label={stream.nextAction} aria-hidden />
        {errorMsg && (
          <p className="detail-incident-warning" role="alert">
            {errorMsg}
          </p>
        )}
      </div>

      {error && (
        <ErrorToast
          error={error}
          onDismiss={handleDismissError}
          onRetry={error.retry.retryable ? handleRetry : undefined}
          autoDismiss={!error.retry.retryable}
          autoDismissDelayMs={5000}
        />
      )}
    </article>
  );
}
