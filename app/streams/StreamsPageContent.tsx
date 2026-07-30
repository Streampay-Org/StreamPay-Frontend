/**
 * StreamsPageContent
 *
 * Streams list page shell with:
 *  - Staggered cascade fade-in on list load (issue #841)
 *  - prefers-reduced-motion fallback — instant reveal, no motion
 *  - Radiogroup density toggle (Cozy / Compact) with localStorage persistence
 *  - Tag-chip filter bar (rendered only when at least one stream has tags)
 *  - Loading skeleton (3 ghost rows with data-testid="stream-row-skeleton")
 *  - Empty, filtered-empty, error, and populated states
 */
"use client";

import { useMemo, useState, useEffect } from "react";
import { StreamRow, type StreamRowData } from "../components/StreamRow";
import { Skeleton } from "../components/Skeleton";
import { PageError } from "../components/PageError";
import { EmptyState } from "../components/EmptyState";
import { DensityToggle, type Density } from "../components/DensityToggle";
import { TagChips } from "../components/TagChips";

export type StreamsViewState = "loading" | "populated" | "empty" | "error";
export type DensityMode = "comfortable" | "compact";

/** Copy strings – single source of truth for all visible text. */
const streamListCopy = {
  description:
    "Track recipients, rates, statuses, and the next action from one scan-friendly streams list.",
  empty: {
    actionLabel: "Create your first stream",
    description:
      "Define a recipient, cadence, and amount in minutes. Once active, funds flow automatically on your schedule.",
    eyebrow: "First-time setup",
    title: "Start your first stream",
    guidanceSteps: [
      "Choose a collaborator or vendor to pay",
      "Set a cadence: daily, weekly, or monthly",
      "Fund your stream wallet and go live",
    ] as const,
  },
  filtered: {
    actionLabel: "Clear filters",
    description:
      "No streams match your current filters. Try clearing one filter or widening your search to bring more streams back into view.",
    eyebrow: "Streams",
    title: "No streams match your current filters",
  },
  heading: "Streams",
  loadingLabel: "Loading streams…",
  populatedCount: (n: number) => `${n} active record${n === 1 ? "" : "s"}`,
  primaryCta: "Create Stream",
  exportCta: "Export History",
} as const;

/** Demonstration data used when the `streams` prop is omitted. */
export const mockStreams: StreamRowData[] = [
  {
    id: "stream-ada",
    nextAction: "Pause",
    rate: "120 XLM / month",
    recipient: "Ada Creative Studio",
    schedule: "Pays every 30 days",
    status: "active",
    tags: ["design", "vendor"],
  },
  {
    id: "stream-kemi",
    nextAction: "Start",
    rate: "32 XLM / week",
    recipient: "Kemi Onboarding Support",
    schedule: "Draft stream ready to launch",
    status: "draft",
    tags: ["onboarding"],
  },
  {
    id: "stream-yusuf",
    nextAction: "Withdraw",
    rate: "18 XLM / day",
    recipient: "Yusuf QA Partnership",
    schedule: "Ended yesterday with funds available",
    status: "ended",
    tags: ["qa", "vendor"],
  },
];

type StreamsPageContentProps = {
  /** Page-level view state. */
  state?: StreamsViewState;
  /** Streams to render when state is "populated" (or auto-populated). */
  streams?: StreamRowData[];
  /** Error body copy rendered in the error panel. */
  errorMessage?: string;
  /** Bound to the error-state "Try again" button. */
  onRetry?: () => void;
  /**
   * Callback wired to the "Create Stream" hero button and to the empty-state
   * primary CTA. Named `onRetryAction` to match what the tests assert.
   */
  onRetryAction?: () => void;
  /** Switches empty-state copy to the filtered variant when the view is empty. */
  emptyStateVariant?: "default" | "filtered";
  /** Callback for the filtered-empty CTA ("Clear filters"). */
  onClearFilters?: () => void;
  /** Seed density on mount (tests use this to skip the localStorage effect). */
  initialDensity?: Density;
};

/* ─── Loading skeleton ──────────────────────────────────────────────────── */

/**
 * Three ghost-row articles that mirror a populated StreamRow's height so
 * the page doesn't jump when real data arrives.
 *
 * The outer wrapper carries `aria-label="Loading streams"` (checked by tests)
 * and `role="status"` so it's announced politely.
 */
function StreamListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading streams"
      className="stream-list-loading"
    >
      <p className="skeleton-heading-label">{streamListCopy.loadingLabel}</p>
      <div className="stream-list" aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
          <article
            key={i}
            data-testid="stream-row-skeleton"
            className="stream-row stream-row--skeleton"
            /* Stagger the skeleton shimmer enter to mirror the cascade */
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="stream-row__meta">
              <Skeleton variant="title" width="45%" className="stream-row__skeleton-title" />
              <Skeleton variant="text" width="30%" />
            </div>
            <div className="stream-row__indicators">
              <Skeleton variant="badge" width="4.25rem" height="1.5rem" />
              <Skeleton variant="button" width="5.5rem" height="2rem" />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────────────── */

export function StreamsPageContent({
  state,
  streams = mockStreams,
  errorMessage = "There was a problem fetching your streams. Check your connection and try again.",
  onRetry,
  onRetryAction,
  emptyStateVariant = "default",
  onClearFilters,
  initialDensity,
}: StreamsPageContentProps) {
  /* ── Density toggle (radiogroup; persists to localStorage) ── */
  const [density, setDensity] = useState<Density>(initialDensity ?? "cozy");

  /* Sync from localStorage after hydration (skipped when initialDensity is provided) */
  useEffect(() => {
    if (initialDensity !== undefined) return;
    try {
      const stored = window.localStorage.getItem("streampay-density");
      if (stored === "cozy" || stored === "compact") setDensity(stored);
    } catch {
      /* localStorage unavailable */
    }
  }, [initialDensity]);

  const handleDensityChange = (next: Density) => {
    setDensity(next);
    try {
      window.localStorage.setItem("streampay-density", next);
    } catch {
      /* ignore */
    }
  };

  /* ── Tag filter ── */
  const allTags = useMemo(
    () =>
      Array.from(
        new Set(streams.flatMap((s) => s.tags ?? [])),
      ),
    [streams],
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const filteredStreams = useMemo(
    () =>
      selectedTag
        ? streams.filter((s) => s.tags?.includes(selectedTag))
        : streams,
    [streams, selectedTag],
  );

  /* ── Derived view state ── */
  const isLoading = state === "loading";
  const isError = state === "error";
  // Explicit empty OR auto-detected empty when state is unset/populated
  const isEmpty =
    state === "empty" || (state !== "loading" && state !== "error" && streams.length === 0);
  const isFilteredEmpty = emptyStateVariant === "filtered" && streams.length === 0 && !isEmpty;
  const isPopulated = !isLoading && !isError && !isEmpty;

  const populatedCount = streamListCopy.populatedCount(streams.length);

  /* ── Toolbar visibility ── */
  const showToolbar = isPopulated;

  return (
    <main className="page-shell">
      {/* ── Page hero ─────────────────────────────────────────────────── */}
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">{streamListCopy.heading}</p>
          <h1 className="page-hero__title">Manage every stream from one list.</h1>
          <p className="page-hero__description">{streamListCopy.description}</p>
        </div>

        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button className="button button--secondary" type="button">
            {streamListCopy.exportCta}
          </button>
          <button
            className="button button--primary"
            type="button"
            onClick={onRetryAction}
          >
            {streamListCopy.primaryCta}
          </button>
        </div>
      </section>

      {/* ── Streams section ───────────────────────────────────────────── */}
      <section className="stream-layout" aria-labelledby="streams-overview-title">
        <div className="section-heading">
          <div className="section-heading__toolbar">
            <div>
              <h2 className="section-heading__title" id="streams-overview-title">
                Streams overview
              </h2>
              <p className="section-heading__description">
                Recipient, rate, status, and the primary next action stay visible at a glance.
              </p>
            </div>

            {/* Density toggle — only shown when the list is populated */}
            {showToolbar && (
              <DensityToggle value={density} onChange={handleDensityChange} />
            )}
          </div>

          {/* Active-record count */}
          {isPopulated && (
            <p className="section-heading__meta">{populatedCount}</p>
          )}
        </div>

        {/* Tag-chip filter bar — only shown when streams carry tags */}
        {isPopulated && allTags.length > 0 && (
          <TagChips
            tags={allTags}
            selectedTag={selectedTag}
            onTagClick={setSelectedTag}
          />
        )}

        {/* ── State rendering ─────────────────────────────────────────── */}
        {isLoading ? (
          <StreamListSkeleton />
        ) : isError ? (
          <PageError
            heading="Couldn't load your streams"
            message={errorMessage}
            onRetry={onRetry}
          />
        ) : isEmpty || isFilteredEmpty ? (
          <EmptyState
            eyebrow={
              isFilteredEmpty
                ? streamListCopy.filtered.eyebrow
                : streamListCopy.empty.eyebrow
            }
            title={
              isFilteredEmpty
                ? streamListCopy.filtered.title
                : streamListCopy.empty.title
            }
            description={
              isFilteredEmpty
                ? streamListCopy.filtered.description
                : streamListCopy.empty.description
            }
            actionLabel={
              isFilteredEmpty
                ? streamListCopy.filtered.actionLabel
                : streamListCopy.empty.actionLabel
            }
            onAction={isFilteredEmpty ? onClearFilters : onRetryAction}
            guidanceSteps={isFilteredEmpty ? undefined : [...streamListCopy.empty.guidanceSteps]}
          />
        ) : (
          /*
           * Cascade animation: each StreamRow receives an inline
           * `--cascade-index` custom property. The CSS keyframe
           * `stream-cascade-in` uses it to stagger opacity + translateY
           * across the list. A `prefers-reduced-motion` guard in
           * globals.css suppresses all motion for users who request it.
           */
          <section
            aria-label="Streams list"
            className={`stream-list${density === "compact" ? " stream-list--compact" : ""}`}
          >
            {filteredStreams.map((stream, index) => (
              <div
                key={stream.id}
                className="stream-cascade-item"
                style={
                  /* Index is passed via a CSS custom property so the
                     animation-delay calculation stays in CSS-land.     */
                  { "--cascade-index": index } as React.CSSProperties
                }
              >
                <StreamRow
                  stream={stream}
                  density={density === "compact" ? "compact" : "cozy"}
                />
              </div>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}

/*
 * Forward-export for Storybook / design-QA previews.
 */
export { StreamListSkeleton };
