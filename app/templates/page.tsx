import { Suspense } from "react";
import TemplatesPageClient from "./templates-client";

/**
 * Server Component shell for /templates (#1691).
 *
 * The interactive gallery is a client component that relies on the URL query
 * (useSearchParams); it is streamed inside a route-level Suspense boundary so
 * the shell renders without client JS and the grid can warm on the server.
 */
export default function TemplatesPage() {
  return (
    <Suspense fallback={<TemplatesPageShellFallback />}>
      <TemplatesPageClient />
    </Suspense>
  );
}

function TemplatesPageShellFallback() {
  return (
    <main className="page-shell" aria-busy="true">
      <section className="page-hero" />
    </main>
  );
}
