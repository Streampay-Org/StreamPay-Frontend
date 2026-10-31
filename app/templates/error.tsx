"use client";
import { PageError } from "../components/PageError";
export default function ErrorBoundary({ reset }: { reset: () => void }) {
  return <PageError heading="Couldn't load templates" message="Try loading the templates again." onRetry={reset} />;
}
