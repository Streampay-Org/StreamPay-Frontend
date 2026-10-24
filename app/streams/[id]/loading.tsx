/**
 * Streaming loading UI for /streams/[id].
 *
 * Next.js renders this file automatically while the server component above it
 * resolves, so users see a skeleton rather than a blank page on slow networks.
 * The skeleton mirrors the section structure of StreamDetailClient to prevent
 * layout shift when the real page swaps in.
 *
 * Accessibility: the wrapper is a `role="status"` region labelled "Loading
 * stream details" so assistive tech announces the pending state, and the
 * shimmer animation is disabled under `prefers-reduced-motion` via the CSS
 * guard in globals.css.
 */

import { Skeleton } from "../../components/Skeleton";

function SkeletonField() {
  return (
    <div className="detail-loading__field">
      <Skeleton variant="label" width="6rem" />
      <Skeleton variant="value" width="12rem" />
    </div>
  );
}

export default function StreamDetailLoading() {
  return (
    <main className="page-shell">
      <div className="detail-loading" role="status" aria-busy="true" aria-label="Loading stream details">
        <span className="sr-only">Loading stream details…</span>

        {/* Back link skeleton */}
        <div className="no-print">
          <Skeleton variant="text" width="10rem" />
        </div>

        {/* Sticky hero header skeleton */}
        <header
          className="detail-loading__hero page-hero sticky top-0 z-20 backdrop-blur-md bg-white/80 dark:bg-zinc-900/80 border-b border-zinc-200/80 dark:border-zinc-800/80 transition-all duration-200 py-4 px-2 -mx-2 rounded-b-xl shadow-sm"
        >
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <Skeleton variant="label" width="7rem" />
              <Skeleton variant="text" width="10rem" />
            </div>
            <div className="detail-header-row flex-wrap sm:flex-nowrap items-center justify-between gap-3">
              <Skeleton variant="title" width="14rem" />
              <div className="detail-badges-wrap flex items-center gap-2">
                <Skeleton variant="badge" width="5rem" />
                <Skeleton variant="badge" width="6rem" />
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center justify-between gap-2">
              <Skeleton variant="text" width="12rem" />
              <Skeleton variant="text" width="14rem" />
            </div>
          </div>
        </header>

        {/* Main grid skeleton */}
        <div className="detail-grid detail-loading__grid">
          <div className="detail-left-col">
            <section className="detail-card detail-loading__section" aria-hidden="true">
              <Skeleton variant="title" width="10rem" />
              <div className="detail-loading__field-stack">
                <SkeletonField />
                <SkeletonField />
                <SkeletonField />
                <SkeletonField />
              </div>
            </section>

            <section className="detail-card detail-loading__section" aria-hidden="true">
              <Skeleton variant="title" width="12rem" />
              <Skeleton variant="text" width="16rem" />
            </section>

            <section className="detail-card detail-loading__section" aria-hidden="true">
              <Skeleton variant="title" width="10rem" />
              <Skeleton variant="text" width="18rem" />
              <div className="detail-actions-row">
                <Skeleton variant="button" />
                <Skeleton variant="button" width="10rem" />
                <Skeleton variant="button" width="11rem" />
              </div>
            </section>
          </div>

          <div className="detail-right-col">
            <Skeleton variant="title" width="9rem" />
            <div className="detail-loading__timeline" aria-hidden="true">
              {[0, 1, 2, 3].map((stage) => (
                <div className="detail-loading__timeline-stage" key={stage}>
                  <Skeleton circle height="0.75rem" width="0.75rem" />
                  <Skeleton variant="text" width="11rem" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
