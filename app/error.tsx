"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ErrorRecovery } from "./components/ErrorRecovery";
import { reportClientError } from "@/lib/reportClientError";

type ErrorProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

const CHUNK_RELOAD_KEY = "streampay:chunk-reload";
const CHUNK_RELOAD_WINDOW_MS = 30_000;

function isOutage(error: Error): boolean {
  const haystack = `${error.name} ${error.message}`.toLowerCase();
  return /stellar|horizon|soroban||\brpc\b|network service|service unavailable/.test(
    haystack
  );
}

function isChunkLoadError(error: Error): boolean {
  const haystack = `${error.name} ${error.message}`.toLowerCase();
  return /chunkloaderror|failed to fetch dynamically imported module|loading chunk/i.test(
    haystack
  );
}

function readChunkReloadTimestamp(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeChunkReloadTimestamp(ts: number): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(ts));
  } catch {
    // sessionStorage may be unavailable (private mode, quota); ignore.
  }
}

export default function GlobalError({ error, reset }: ErrorProps) {
  const [reloadBlocked, setReloadBlocked] = useState(false);

  useEffect(() => {
    reportClientError({
      digest: error.digest,
      name: error.name,
      message: error.message,
      stack: error.stack,
      kind: isChunkLoadError(error) ? "chunk" : "boundary",
    });
  }, [error]);

  const handleReset = () => {
    if (!isChunkLoadError(error)) {
      reset();
      return {} as void;
    }

    const now = Date.now();
    const previous = readChunkReloadTimestamp();
    if (previous !== null && now - previous < CHUNK_RELOAD_WINDOW_MS) {
      // Already reloaded once recently; avoid an infinite reload loop.
      setReloadBlocked(true);
      return;
    }

    writeChunkReloadTimestamp(now);
    window.location.reload();
  };

  const outage = isOutage(error);

  if (reloadBlocked) {
    return (
      <ErrorRecovery
        variant="server"
        eyebrole="Update available"
        heading="A new version is available"
        body="StreamPay has been updated. Reload to get the latest version."
        helperNote="If reloading keeps failing, support can help."
        reference={error.digest}
        primaryAction={
          <button
            type="button"
            className="button button--primary error-page__action"
            onClick={() => {
              writeChunkReloadTimestamp(Date.now());
              window.location.reload();
            }}
          >
            Reload
          </button>
        }
        secondaryAction={
          <Link
            className="button button--secondary error-page__action"
            href="/help"
          >
            Contact support
          </Link>
        }
      />
    );
  }

  if (outage) {
    return (
      <ErrorRecovery
        variant="outage"
        eyebrow="Network service"
        heading="Stellar service is temporarily unavailable"
        body="StreamPay cannot reach part of the Stellar service right now. Your funds are not gone. Recent activity may take longer to refresh until the service is back."
        helperNote="You can also check the status page for live updates."
        reference={error.digest}
        primaryAction={
          <button
            type="button"
            className="button button--primary error-page__action"
            onClick={handleReset}
          >
            Try again
          </button>
        }
        secondaryAction={
          <Link
            className="button button--secondary error-page__action"
            href="/help"
          >
            Contact support
          </Link>
        }
      />
    );
  }

  return (
    <ErrorRecovery
      variant="server"
      eyebrow="We're fixing it"
      heading="Something went wrong on our side"
      body="StreamPay is having trouble loading this page right now. Our team is already looking into it."
      helperNote="If this keeps happening, support can help with the page you were trying to reach."
      reference={error.digest}
      primaryAction={
        <button
          type="button"
          className="button button--primary error-page__action"
          onClick={handleReset}
        >
          Try again
        </button>
      }
      secondaryAction={
        <Link
          className="button button--secondary error-page__action"
          href="/activity"
        >
          Visit status page
        </Link>
      }
    />
  );
}
