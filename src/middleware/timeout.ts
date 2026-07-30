/**
 * src/middleware/timeout.ts
 *
 * Per-request deadline middleware for Next.js route handlers.
 *
 * Design notes
 * ─────────────
 * • Wraps `runWithTimeout` from `app/lib/with-timeout.ts`, which implements a
 *   token-bucket + AbortController pattern: work receives an AbortSignal it
 *   can honor for a graceful early stop, and the outer timer fires
 *   `controller.abort()` exactly once when the deadline passes.
 *
 * • When the deadline passes the route handler is interrupted and the caller
 *   receives a `504 Gateway Timeout` with the standard error envelope.  The
 *   `GATEWAY_TIMEOUT` code lets clients distinguish this from a server crash
 *   (`INTERNAL_SERVER_ERROR`).
 *
 * • The timeout value is resolved at call-time, not at module-load, so
 *   environment variable overrides (e.g. in tests or at deploy time) are
 *   always picked up.
 *
 * • The `AbortSignal` is threaded through to the work callback so callers can
 *   wire it into fetch calls, database queries, or between-step checks for a
 *   cooperative early exit before the full deadline.
 *
 * Usage
 * ──────
 * ```ts
 * import { withTimeout, WALLET_TIMEOUT_MS } from '@/src/middleware/timeout';
 *
 * export async function GET(req: NextRequest) {
 *   return withTimeout(WALLET_TIMEOUT_MS, req, async (signal) => {
 *     // ... handler body; pass `signal` to fetch/db calls where possible
 *   });
 * }
 * ```
 */

import { NextResponse } from "next/server";
import { runWithTimeout, TimeoutError } from "@/app/lib/with-timeout";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { logger, getCorrelationContext } from "@/app/lib/logger";

// ── Deadline constants ────────────────────────────────────────────────────────

/**
 * Default wall-clock budget for GET /api/auth/wallet (challenge issuance).
 * Override via the `AUTH_WALLET_TIMEOUT_MS` environment variable.
 */
export const WALLET_CHALLENGE_TIMEOUT_MS =
  Number(process.env.AUTH_WALLET_TIMEOUT_MS) || 5_000;

/**
 * Default wall-clock budget for POST /api/auth/wallet (signature verification).
 * Override via the `AUTH_WALLET_VERIFY_TIMEOUT_MS` environment variable.
 */
export const WALLET_VERIFY_TIMEOUT_MS =
  Number(process.env.AUTH_WALLET_VERIFY_TIMEOUT_MS) || 5_000;

/**
 * Default wall-clock budget for /api/streams.
 * Override via the `STREAMS_TIMEOUT_MS` environment variable.
 */
export const STREAMS_TIMEOUT_MS =
  Number(process.env.STREAMS_TIMEOUT_MS) || 5_000;

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Runs `work` under a per-request deadline.
 *
 * - If `work` completes within `timeoutMs`, its `NextResponse` is returned
 *   unchanged.
 * - If the deadline passes first, `work` is aborted via `AbortSignal` and a
 *   `504 Gateway Timeout` response with the standard error envelope is
 *   returned.
 * - Any other error thrown by `work` propagates to the caller (the route's
 *   outer catch block handles it).
 *
 * @param timeoutMs   Wall-clock budget in milliseconds.
 * @param request     Incoming request — used only for structured logging
 *                    (method, pathname, correlation ID).
 * @param work        Async route body.  Receives an `AbortSignal`; wire it
 *                    into fetch/DB calls so they can cancel cooperatively.
 */
export async function withTimeout(
  timeoutMs: number,
  request: { method?: string; url?: string; headers?: Headers },
  work: (signal: AbortSignal) => Promise<NextResponse>,
): Promise<NextResponse> {
  const startedAt = Date.now();

  try {
    return await runWithTimeout(timeoutMs, work);
  } catch (error) {
    if (error instanceof TimeoutError) {
      const durationMs = Date.now() - startedAt;
      const ctx = getCorrelationContext();

      // Parse the URL safely — `request.url` may be undefined in tests.
      let method = request.method ?? "UNKNOWN";
      let pathname = "(unknown)";
      try {
        if (request.url) {
          pathname = new URL(request.url).pathname;
        }
      } catch {
        // malformed URL — ignore
      }

      logger.warn("Request timed out", {
        method,
        path: pathname,
        timeoutMs,
        durationMs,
        request_id: ctx?.request_id,
        correlation_id: ctx?.correlation_id,
      });

      return errorResponse(
        ErrorCode.GATEWAY_TIMEOUT,
        `Request exceeded the ${timeoutMs}ms deadline.`,
        504,
      );
    }

    // Re-throw non-timeout errors so the route's existing error handling runs.
    throw error;
  }
}
