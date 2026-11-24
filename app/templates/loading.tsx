/**
 * Route-level loading UI for /templates.
 *
 * Mirrors the hero, category/search controls, and template card grid of
 * TemplatesPage so navigation shows a structured placeholder without layout shift.
 */

import { Skeleton } from "../components/Skeleton";

export default function TemplatesLoading() {
  return (
    <main className="page-shell templates-page">
      <div role="status" aria-busy="true" aria-label="Loading templates">
        <span className="sr-only">Loading templates…</span>

        <section className="page-hero" aria-hidden="true">
          <div>
            <Skeleton variant="label" width="6rem" />
            <Skeleton variant="title" width="15rem" />
            <Skeleton variant="text" width="24rem" />
          </div>
        </section>

        <section className="stream-layout" aria-hidden="true">
          <div className="section-heading">
            <div>
              <Skeleton variant="title" width="11rem" />
              <Skeleton variant="text" width="22rem" />
            </div>
          </div>

          <div className="template-controls">
            <div className="template-controls__categories">
              {[0, 1, 2, 3, 4].map((tab) => (
                <Skeleton key={tab} variant="badge" width="4.5rem" />
              ))}
            </div>
            <Skeleton variant="button" width="14rem" />
          </div>

          <div className="template-grid">
            {[0, 1, 2, 3, 4, 5].map((card) => (
              <article key={card} className="template-card template-card--skeleton">
                <div className="template-card__header">
                  <Skeleton variant="badge" width="4rem" height="1.25rem" />
                </div>
                <Skeleton variant="title" width="8rem" height="1.25rem" />
                <div className="template-card__details">
                  <div className="template-card__detail">
                    <Skeleton variant="label" width="3rem" height="0.75rem" />
                    <Skeleton variant="value" width="6rem" height="1rem" />
                  </div>
                  <div className="template-card__detail">
                    <Skeleton variant="label" width="3rem" height="0.75rem" />
                    <Skeleton variant="value" width="5rem" height="1rem" />
                  </div>
                </div>
                <Skeleton variant="button" width="7.5rem" height="2.75rem" />
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
