export interface ClientErrorPayload {
  digest?: string;
  name?: string;
  message?: string;
  stack?: string;
  kind?: "boundary" | "chunk" | "unhandled";
}

export function reportClientError(payload: ClientErrorPayload): void {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/client-errors", body);
    } else {
      fetch("/api/client-errors", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Reporting should never throw or break UI
  }
}
