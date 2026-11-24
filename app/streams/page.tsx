import { Suspense } from "react";
import { StreamsPageContent } from "./StreamsPageContent";

export default function StreamsPage() {
  return (
    <Suspense fallback={null}>
      <StreamsPageContent />
    </Suspense>
  );
}
