/**
 * Route-level loading UI for /streams.
 *
 * Mirrors the hero, toolbar, and list row structure of StreamsPageContent
 * so navigation shows a structured placeholder without layout shift.
 */

import { Skeleton } from "../components/Skeleton";

export default function StreamsLoading() {
  return (
    <main className="page-shell">
      <div role="status" aria-busy="true" aria-label="Loading streams">
        <span className="sr-only">Loading streams…</span>

        <section className="page-hero" aria-hidden="true">
          <div>
            <Skeleton variant="label" width="5rem" />
            <Skeleton variant="title" width="14rem" />
            <Skeleton variant="text" width="24rem" />
          </div>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
            <Skeleton variant="button" width="8.5rem" />
            <Skeleton variant="button" width="8.5rem" />
          </div>
        </section>

        <section className="stream-layout" aria-hidden="true">
          <div className="section-heading">
            <div className="section-heading__toolbar">
              <div>
                <Skeleton variant="title" width="11rem" />
                <Skeleton variant="text" width="22rem" />
              </div>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                <Skeleton variant="button" width="8rem" />
                <Skeleton variant="button" width="7rem" />
              </div>
            </div>
          </div>

          <div className="stream-list">
            {[0, 1, 2, 3].map((row) => (
              <article key={row} className="stream-row stream-row--skeleton">
                <div className="stream-row__meta">
                  <Skeleton variant="title" width="45%" className="stream-row__skeleton-title" />
                  <Skeleton variant="text" width="30%" />
                </div>
                <div className="stream-row__details">
                  <Skeleton variant="value" width="6rem" />
                  <Skeleton variant="badge" width="5rem" />
                </div>
                <div className="stream-row__actions">
                  <Skeleton variant="button" width="6rem" />
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
