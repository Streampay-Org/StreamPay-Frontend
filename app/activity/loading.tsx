/**
 * Route-level loading UI for /activity.
 *
 * Mirrors the hero, date-range filter bar, and timeline event groups of
 * ActivityPage so navigation shows a structured placeholder without layout shift.
 */

import { Skeleton } from "../components/Skeleton";

export default function ActivityLoading() {
  return (
    <main className="page-shell">
      <div role="status" aria-busy="true" aria-label="Loading activity">
        <span className="sr-only">Loading activity…</span>

        <section className="page-hero" aria-hidden="true">
          <div>
            <Skeleton variant="label" width="5rem" />
            <Skeleton variant="title" width="14rem" />
            <Skeleton variant="text" width="24rem" />
          </div>
        </section>

        <section className="stream-layout" aria-hidden="true">
          <div className="section-heading">
            <div>
              <Skeleton variant="title" width="10rem" />
              <Skeleton variant="text" width="22rem" />
            </div>
          </div>

          <div className="activity-filters flex flex-col gap-2">
            <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
              <Skeleton variant="button" width="10rem" />
              <Skeleton variant="button" width="10rem" />
            </div>
          </div>

          <div className="stream-list">
            {[0, 1, 2, 3].map((row) => (
              <article key={row} className="stream-row stream-row--skeleton">
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <Skeleton circle width="2rem" height="2rem" />
                  <div className="stream-row__meta">
                    <Skeleton variant="title" width="12rem" />
                    <Skeleton variant="text" width="8rem" />
                  </div>
                </div>
                <div className="stream-row__details">
                  <Skeleton variant="badge" width="5rem" />
                  <Skeleton variant="text" width="6rem" />
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
