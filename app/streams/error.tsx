"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ErrorRecovery } from "../components/ErrorRecovery";
import { isChunkLoadError } from "../utils/chunk-load-error";
import { reportClientError } from "@/lib/reportClientError";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function StreamsError({ error, reset }: Props) {
  useEffect(() => {
    const err = error as Partial<Error & { digest?: string }> | null | undefined;
    reportClientError({
      digest: typeof err?.digest === "string" ? err.digest : undefined,
      name: typeof err?.name === "string" ? err.name : undefined,
      message:
        typeof err?.message === "string"
          ? err.message
          : typeof error === "string"
            ? error
            : undefined,
      stack: typeof err?.stack === "string" ? err.stack : undefined,
      kind: isChunkLoadError(error) ? "chunk" : "boundary",
    });
  }, [error]);

  const handleReset = () => {
    if (isChunkLoadError(error)) {
      window.location.reload();
    } else {
      reset();
    }
  };

  return (
    <ErrorRecovery
      body="Something went wrong while loading your streams. Your payment data is safe — this is a display issue only. Try again, or return to the dashboard."
      eyebrow="Streams unavailable"
      heading="We couldn't load your streams"
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
      reference={typeof error?.digest === "string" ? error.digest : undefined}
      secondaryAction={
        <Link className="button button--secondary error-page__action" href="/">
          Back to home
        </Link>
      }
      variant="server"
    />
  );
}
