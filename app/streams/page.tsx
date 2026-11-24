import { StreamsDashboard } from "./StreamsDashboard";
import { Suspense } from "react";

export default function StreamsPage() {
  return <StreamsDashboard />;
  return (
    <Suspense fallback={null}>
      <StreamsPageContent />
    </Suspense>
  );
}
