/**
 * Route-level loading UI for /contacts.
 *
 * Mirrors the hero, search/sort toolbar, and contact list rows of ContactsPage
 * so navigation shows a structured placeholder without layout shift.
 */

import { Skeleton } from "../components/Skeleton";

export default function ContactsLoading() {
  return (
    <main className="page-shell">
      <div role="status" aria-busy="true" aria-label="Loading contacts">
        <span className="sr-only">Loading contacts…</span>

        <header className="page-hero" aria-hidden="true">
          <div className="page-hero__content">
            <Skeleton variant="label" width="5rem" />
            <Skeleton variant="title" width="12rem" />
            <Skeleton variant="text" width="24rem" />
          </div>
        </header>

        <div style={{ maxWidth: "48rem", width: "100%", margin: "0 auto" }} aria-hidden="true">
          <div
            style={{
              display: "flex",
              gap: "1rem",
              alignItems: "center",
              marginBottom: "1.5rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: "200px" }}>
              <Skeleton variant="button" width="100%" />
            </div>
            <Skeleton variant="button" width="8rem" />
            <Skeleton variant="button" width="8.5rem" />
          </div>

          <div className="stream-list">
            {[0, 1, 2, 3].map((row) => (
              <article key={row} className="stream-row stream-row--skeleton">
                <div className="stream-row__meta">
                  <Skeleton variant="title" width="11rem" />
                  <Skeleton variant="text" width="16rem" />
                  <Skeleton variant="text" width="12rem" />
                </div>
                <div className="contact-row__actions" style={{ display: "flex", gap: "0.5rem" }}>
                  <Skeleton variant="button" width="4.5rem" />
                  <Skeleton variant="button" width="5rem" />
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
