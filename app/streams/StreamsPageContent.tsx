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

import { useMemo, useState, useEffect, useRef } from "react";
import Link from "next/link";
import { StreamRow, type StreamRowData } from "../components/StreamRow";
import {
  CompareStreamsModal,
  type CompareStream,
} from "../components/CompareStreamsModal";
import { Skeleton } from "../components/Skeleton";
import { PageError } from "../components/PageError";
import { EmptyState } from "../components/EmptyState";
import { DensityToggle, type Density } from "../components/DensityToggle";
import {
  SortDropdown,
  isSortOption,
  type SortOption,
} from "../components/SortDropdown";
import { TagChips } from "../components/TagChips";
import { safeStorage } from "../lib/safeStorage";
import { mockStreams } from "./fixtures";
import { sortStreams } from "./sortStreams";
import { useRovingGrid } from "./useRovingGrid";

const SORT_STORAGE_KEY = "streampay-streams-sort";

function extractAssetUnit(rate: string): string {
  const match = rate.match(/[0-9.,]+\s+([A-Za-z0-9]+)/);
  return match ? match[1] : "";
}

export function toCompareStream(stream: StreamRowData): CompareStream {
  const unit = extractAssetUnit(stream.rate);
  const unitSuffix = unit ? ` ${unit}` : "";

  let balance = "—";
  if (
    typeof stream.totalAmount === "number" &&
    typeof stream.accruedAmount === "number"
  ) {
    const remaining = Math.max(0, stream.totalAmount - stream.accruedAmount);
    balance = `${remaining.toLocaleString()}${unitSuffix} remaining`;
  } else if (typeof stream.accruedAmount === "number") {
    balance = `${stream.accruedAmount.toLocaleString()}${unitSuffix} accrued`;
  } else if (typeof stream.totalAmount === "number") {
    balance = `${stream.totalAmount.toLocaleString()}${unitSuffix} total`;
  }

  let runway = stream.schedule || "—";
  if (stream.endsAt) {
    const endMs = new Date(stream.endsAt).getTime();
    if (!Number.isNaN(endMs)) {
      const diffMs = endMs - Date.now();
      if (diffMs <= 0) {
        runway = "Ended";
      } else {
        const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        runway = `${days} day${days === 1 ? "" : "s"} remaining`;
      }
    }
  }

  return {
    id: stream.id,
    recipient: stream.recipient,
    rate: stream.rate,
    runway,
    balance,
    status: stream.status,
    createdAt: stream.startedAt ?? "",
  };
}

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
  importCta: "Import CSV",
} as const;

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
  /** Seed sort order on mount (tests use this to skip the storage effect). */
  initialSort?: SortOption;
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
            aria-hidden="true"
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
  initialSort,
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

  /* ── Sort dropdown (persists via safeStorage) ── */
  const [sort, setSort] = useState<SortOption>(initialSort ?? "newest");

  /* Sync from safeStorage after hydration (skipped when initialSort is provided) */
  useEffect(() => {
    if (initialSort !== undefined) return;
    const stored = safeStorage.getItem(SORT_STORAGE_KEY);
    if (isSortOption(stored)) {
      setSort(stored);
    }
  }, [initialSort]);

  const handleSortChange = (next: SortOption) => {
    setSort(next);
    safeStorage.setItem(SORT_STORAGE_KEY, next);
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

  const sortedStreams = useMemo(
    () => sortStreams(filteredStreams, sort),
    [filteredStreams, sort],
  );

  /* ── Compare selection state (max 2) ── */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const compareButtonRef = useRef<HTMLButtonElement>(null);

  const filteredIdsKey = useMemo(
    () => filteredStreams.map((s) => s.id).join(","),
    [filteredStreams],
  );

  // Clear selection whenever the filtered list changes so hidden streams cannot stay selected.
  useEffect(() => {
    setSelectedIds([]);
    setIsCompareOpen(false);
  }, [filteredIdsKey]);

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      if (prev.length >= 2) {
        return prev;
      }
      return [...prev, id];
    });
  };

  const selectedStreams = useMemo(
    () =>
      selectedIds
        .map((id) => filteredStreams.find((s) => s.id === id))
        .filter((s): s is StreamRowData => s !== undefined),
    [selectedIds, filteredStreams],
  );

  const handleCloseCompare = () => {
    setIsCompareOpen(false);
    compareButtonRef.current?.focus();
  };

  /* ── Derived view state ── */
  const isLoading = state === "loading";
  const isError = state === "error";
  // Explicit empty OR auto-detected empty when state is unset/populated
  const isEmpty =
    state === "empty" || (state !== "loading" && state !== "error" && streams.length === 0);
  const isFilteredEmpty = emptyStateVariant === "filtered" && streams.length === 0 && !isEmpty;
  const isPopulated = !isLoading && !isError && !isEmpty;

  const populatedCount = streamListCopy.populatedCount(streams.length);
  const rowIds = sortedStreams.map((stream) => stream.id);
  const { gridProps, getCellProps, registerCell } = useRovingGrid({
    rowIds,
    columnCount: 4,
  });

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
          <Link className="button button--secondary" href="/streams/import">
            {streamListCopy.importCta}
          </Link>
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

            {/* Compare + Sort dropdown + Density toggle — only shown when the list is populated */}
            {showToolbar && (
              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  ref={compareButtonRef}
                  type="button"
                  className="button button--secondary"
                  disabled={selectedIds.length !== 2}
                  onClick={() => setIsCompareOpen(true)}
                >
                  {selectedIds.length > 0
                    ? `Compare (${selectedIds.length}/2)`
                    : "Compare"}
                </button>
                <SortDropdown value={sort} onChange={handleSortChange} />
                <DensityToggle value={density} onChange={handleDensityChange} />
              </div>
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
            {...gridProps}
          >
            <div className="stream-grid__header sr-only" role="row" aria-rowindex={1}>
              {["Recipient", "Rate and status", "Progress", "Actions"].map(
                (label, index) => (
                  <div key={label} role="columnheader" aria-colindex={index + 1}>
                    {label}
                  </div>
                ),
              )}
            </div>
            {sortedStreams.map((stream, index) => {
              const isSelected = selectedIds.includes(stream.id);
              const isSelectionDisabled = !isSelected && selectedIds.length >= 2;
              return (
                <div
                  key={stream.id}
                  className="stream-cascade-item"
                  role="presentation"
                  style={
                    /* Index is passed via a CSS custom property so the
                       animation-delay calculation stays in CSS-land.     */
                    {
                      "--cascade-index": index,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: "0.75rem",
                    } as React.CSSProperties
                  }
                >
                  <label
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: "2.75rem",
                      minHeight: "2.75rem",
                      cursor: isSelectionDisabled ? "not-allowed" : "pointer",
                      flexShrink: 0,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isSelectionDisabled}
                      onChange={() => handleToggleSelect(stream.id)}
                      aria-label={`Select stream for comparison: ${stream.recipient}`}
                      style={{
                        width: "1.125rem",
                        height: "1.125rem",
                        cursor: isSelectionDisabled ? "not-allowed" : "pointer",
                      }}
                    />
                  </label>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <StreamRow
                      stream={stream}
                      density={density === "compact" ? "compact" : "cozy"}
                      gridMode
                      rowIndex={index + 2}
                      gridCellProps={(columnIndex) => ({
                        ...getCellProps(index, columnIndex),
                        ref: (element) => registerCell(index, columnIndex, element),
                      })}
                    />
                  </div>
                </div>
              );
            })}
          </section>
        )}
      </section>

      {selectedStreams.length === 2 && (
        <CompareStreamsModal
          isOpen={isCompareOpen}
          onClose={handleCloseCompare}
          streamA={toCompareStream(selectedStreams[0]!)}
          streamB={toCompareStream(selectedStreams[1]!)}
        />
      )}
    </main>
  );
}

/*
 * Forward-export for Storybook / design-QA previews.
 */
export { StreamListSkeleton };