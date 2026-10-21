export type ClientErrorKind = "boundary" | "chunk" | "unhandled";

export interface ClientErrorReport {
  /** React error-boundary digest, when the error came from a boundary. */
  digest?: string;
  name: string;
  message: string;
  stack?: string;
  kind: ClientErrorKind;
}

const ENDPOINT = "/api/client-errors";
const DEDUPE_WINDOW_MS = 60_000;

/** Fingerprint -> timestamp of the last report, used for the 60 s dedupe. */
const recentReports = new Map<string, number>();

function fingerprint(report: ClientErrorReport): string {
  return [report.kind, report.name, report.message, report.digest ?? ""].join(
    "\u0000",
  );
}

function isDuplicate(report: ClientErrorReport, now: number): boolean {
  const key = fingerprint(report);
  const previous = recentReports.get(key);
  if (previous !== undefined && now - previous < DEDUPE_WINDOW_MS) {
    return true;
  }

  recentReports.set(key, now);
  for (const [entry, timestamp] of recentReports) {
    if (now - timestamp >= DEDUPE_WINDOW_MS) {
      recentReports.delete(entry);
    }
  }
  return false;
}

/**
 * Report a client-side error to `POST /api/client-errors`.
 *
 * Fire-and-forget by design: it never throws, never blocks rendering, sends
 * only the pathname (never the full URL, cookies or form values) and drops
 * identical reports for 60 seconds. It is a no-op under Jest and during SSR.
 */
export function reportClientError(report: ClientErrorReport): void {
  try {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV === "test") return;

    const now = Date.now();
    if (isDuplicate(report, now)) return;

    const payload = JSON.stringify({
      digest: report.digest,
      name: report.name.slice(0, 120),
      message: report.message.slice(0, 500),
      stack: report.stack ? report.stack.slice(0, 4096) : undefined,
      kind: report.kind,
      route: window.location.pathname,
      release: process.env.NEXT_PUBLIC_RELEASE ?? undefined,
      ts: new Date(now).toISOString(),
    });

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const queued = navigator.sendBeacon(
        ENDPOINT,
        new Blob([payload], { type: "application/json" }),
      );
      if (queued) return;
    }

    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      // Reporting must never surface to the user or the error boundary.
    });
  } catch {
    // Reporting must never throw.
  }
}

/** Clears the dedupe cache. Exposed for tests. */
export function resetClientErrorReports(): void {
  recentReports.clear();
}
