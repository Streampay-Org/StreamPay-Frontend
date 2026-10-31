import { TemplateGridSkeleton } from "./templates-client";
export default function Loading() {
  return <main className="page-shell templates-page" aria-busy="true">
    <h1>Start with a template</h1>
    <p role="status">Loading templates…</p>
    <TemplateGridSkeleton />
  </main>;
}
