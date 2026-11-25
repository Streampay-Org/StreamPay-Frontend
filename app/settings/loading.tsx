/**
 * Route-level loading UI for /settings.
 *
 * Mirrors the hero, tab strip, and active settings group panel of SettingsPage
 * so navigation shows a structured placeholder without layout shift.
 */

import { Skeleton } from "../components/Skeleton";

export default function SettingsLoading() {
  return (
    <main className="page-shell">
      <div role="status" aria-busy="true" aria-label="Loading settings">
        <span className="sr-only">Loading settings…</span>

        <header className="page-hero" aria-hidden="true">
          <div className="page-hero__content">
            <Skeleton variant="label" width="6.5rem" />
            <Skeleton variant="title" width="10rem" />
            <Skeleton variant="text" width="22rem" />
            <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem" }}>
              <Skeleton variant="text" width="7.5rem" />
              <Skeleton variant="text" width="6rem" />
            </div>
          </div>
        </header>

        <div className="settings-layout" aria-hidden="true">
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem" }}>
            <Skeleton variant="button" width="7.5rem" />
            <Skeleton variant="button" width="8.5rem" />
          </div>

          <section className="settings-group">
            <div className="settings-group__header">
              <Skeleton variant="title" width="9rem" />
              <Skeleton variant="text" width="18rem" />
            </div>
            <div className="settings-group__content" style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "1rem" }}>
              <Skeleton variant="value" width="14rem" />
              <Skeleton variant="button" width="10rem" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
