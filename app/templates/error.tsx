"use client";

import "./templates.module.css";
import { useEffect } from "react";
import { PageError } from "../components/PageError";

export default function TemplatesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page-shell templates-page">
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">Templates</p>
          <h1 className="page-hero__title">Start with a template.</h1>
          <p className="page-hero__description">
            Reusable stream presets to set up recurring payments in seconds.
            Pick a template, adjust the amount, and launch.
          </p>
        </div>
      </section>

      <section
        aria-labelledby="templates-overview-title"
        aria-live="polite"
        className="stream-layout"
      >
        <div className="section-heading">
          <div>
            <h2 className="section-heading__title" id="templates-overview-title">
              Browse templates
            </h2>
            <p className="section-heading__description">
              Filter by category or search to find the right preset for your stream.
            </p>
          </div>
        </div>

        <span aria-live="polite" className="sr-only" role="status">
          Failed to load templates.
        </span>

        <PageError
          heading="Couldn't load templates"
          message="There was a problem fetching templates. Check your connection and try again."
          onRetry={reset}
        />
      </section>
    </main>
  );
}
