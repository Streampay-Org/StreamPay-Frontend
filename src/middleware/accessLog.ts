import { getCorrelationContext, logger } from "@/app/lib/logger";

export interface AccessLogContext {
  method: string;
  path: string;
  status: number;
  durationMs?: number;
  /** Authenticated actor's wallet address (undefined for anonymous/unauthenticated requests). */
  actorId?: string;
  /** Export job ID when the request pertains to a specific export job. */
  exportJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

/**
 * Emits a single structured access-log entry for a completed HTTP request.
 *
 * Fields included:
 * - method, path, status, durationMs — standard HTTP request fields.
 * - actorId  — wallet address of the authenticated caller (omitted for anon requests).
 * - exportJobId — export job ID associated with the request (omitted when absent).
 * - request_id, correlation_id, traceparent — from the active correlation context.
 * - errorCode, errorMessage — when the response is an error.
 * - Any additional caller-supplied key/value pairs (spread into log entry).
 *
 * This function is safe to call from any status code path (2xx, 4xx, 5xx).
 */
export function logAccessEvent(context: AccessLogContext): void {
  const correlation = getCorrelationContext();

  // Build the core structured payload; only include defined optional fields.
  const payload: Record<string, unknown> = {
    method: context.method,
    path: context.path,
    status: context.status,
    request_id: correlation?.request_id,
    correlation_id: correlation?.correlation_id,
  };

  if (correlation?.traceparent !== undefined) {
    payload.traceparent = correlation.traceparent;
  }
  if (context.durationMs !== undefined) {
    payload.durationMs = context.durationMs;
  }
  if (context.actorId !== undefined) {
    payload.actorId = context.actorId;
  }
  if (context.exportJobId !== undefined) {
    payload.exportJobId = context.exportJobId;
  }
  if (context.errorCode !== undefined) {
    payload.errorCode = context.errorCode;
  }
  if (context.errorMessage !== undefined) {
    payload.errorMessage = context.errorMessage;
  }

  // Spread any extra caller-supplied fields (excluding the ones already handled).
  const handled = new Set([
    "method",
    "path",
    "status",
    "durationMs",
    "actorId",
    "exportJobId",
    "errorCode",
    "errorMessage",
  ]);
  for (const [key, value] of Object.entries(context)) {
    if (!handled.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  logger.info("http access", payload);
}
