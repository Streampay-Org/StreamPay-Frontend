"use client";

import Link from "next/link";
import { ErrorRecovery } from "../../components/ErrorRecovery";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

function isChunkLoadError(error: Error): boolean {
  const haystack = `${error.name} ${error.message}`.toLowerCase();
  return /chunkloaderror|failed to fetch dynamically imported module|loading chunk/i.test(
    haystack
  );
}

/**
 * Route-level error boundary for /streams/[id].
 *
 * Shown when the server component throws during rendering (e.g. the
 * persistence-store loader fails, serialisation error). Uses the shared
 * ErrorRecovery layout so the visual treatment matches the global error page,
 * while messaging is specific to the stream detail context.
 */
export default function StreamDetailError({ error, reset }: Props) {
  const handleReset = () => {
    if (isChunkLoadError(error)) {
      window.location.reload();
    } else {
      reset();
    }
  };

  return (
    <ErrorRecovery
      body="Something went wrong while loading this stream. Your payment data is safe — this is a display issue only. Try again, or go back to your streams list."
      eyebrow="Stream unavailable"
      heading="We couldn't load this stream"
      helperNote="If the problem persists, contact support with the reference below."
      primaryAction={
        <button
          className="button button--primary error-page__action"
          onClick={handleReset}
          type="button"
        >
          Try again
        </button>
      }
      reference={error.digest}
      secondaryAction={
        <Link
          className="button button--secondary error-page__action"
          href="/streams"
        >
          Back to streams
        </Link>
      }
      variant="server"
    />
  );
}
