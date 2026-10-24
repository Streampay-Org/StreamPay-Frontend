import "./templates.module.css";
import { Suspense } from "react";
import type { Metadata } from "next";
import { listTemplates } from "../lib/repositories/templates";
import { TemplateGridSkeleton } from "./TemplateSkeletons";
import { TemplatesBrowser } from "./TemplatesBrowser";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Templates | StreamPay",
  description:
    "Reusable stream presets to set up recurring payments in seconds. Pick a template, adjust the amount, and launch.",
};

export default async function TemplatesPage() {
  const templates = await listTemplates();

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

        <Suspense fallback={<TemplateGridSkeleton />}>
          <TemplatesBrowser initialTemplates={templates} />
        </Suspense>
      </section>
    </main>
  );
}
