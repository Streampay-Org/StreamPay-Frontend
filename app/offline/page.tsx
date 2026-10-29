import Link from "next/link";
import { ErrorRecovery } from "../components/ErrorRecovery";

export default function OfflinePage() {
  return (
    <ErrorRecovery
      variant="outage"
      eyebrow="Connection unavailable"
      heading="You’re offline"
      body="StreamPay couldn’t reach the network. Check your connection and try again."
      helperNote="Your account data is not available while offline."
      primaryAction={
        <Link
          className="button button--primary error-page__action"
          href="/"
        >
          Retry
        </Link>
      }
      secondaryAction={
        <Link
          className="button button--secondary error-page__action"
          href="/help"
        >
          Visit help
        </Link>
      }
    />
  );
}
