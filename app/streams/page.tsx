import { StreamsPageContent } from "./StreamsPageContent";

export default function StreamsPage() {
  return <StreamsPageContent state="empty" streams={[]} isWalletConnected={false} />;
}
