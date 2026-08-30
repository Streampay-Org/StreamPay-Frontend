import { createError } from "@/app/lib/errors/mapper";
import type { StreamPayError } from "@/app/lib/errors/types";

/**
 * Confirmation guard for stream mutations.
 *
 * Every stream-mutation endpoint (`start`, `pause`, `stop`, `settle`,
 * `withdraw`, `cancel`) returns `{ data: Stream }` on success, where `data`
 * carries the freshly-persisted server state including `status`. A success is
 * only ever presented to the user when this function returns a value; a
 * response that resolves without a confirmed `data.status` is treated as NOT
 * applied. This is the core invariant that keeps an offline/stale request from
 * surfacing as a false "success".
 */
export function extractConfirmedStreamStatus(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  const status = (data as Record<string, unknown>).status;
  return typeof status === "string" && status.length > 0 ? status : null;
}

/**
 * Error surfaced when a stream mutation is blocked because the browser
 * reports the device is offline. The message states explicitly that the
 * action was NOT applied so a stale "success" can never be presented.
 *
 * `NETWORK_UNAVAILABLE` is retryable, so the ErrorToast keeps a Retry button
 * that re-enters the guarded handler once connectivity returns.
 */
export function createOfflineMutationError(): StreamPayError {
  return createError("NETWORK_UNAVAILABLE", {
    title: "Offline - action not applied",
    detail:
      "You appear to be offline. The action was NOT applied. Reconnect, then retry.",
  });
}

/**
 * Error surfaced when a mutation response resolves without a confirmed server
 * state transition. Fail-closed: the UI never presents a success it cannot
 * verify against the returned stream state.
 */
export function createUnconfirmedMutationError(action: string): StreamPayError {
  return createError("UNKNOWN_ERROR", {
    title: "Action not confirmed",
    detail: `The server did not confirm the "${action}" action. Refresh and try again.`,
  });
}