/**
 * GET /api/admin/streams/health
 *
 * Secure admin endpoint returning aggregated health metrics for the streams subsystem.
 *
 * Metrics returned:
 *   - total: total count of all streams in the system
 *   - byStatus: record mapping status string to count (e.g. active, paused, errored, stuck)
 *   - failureRatePct: percentage of streams currently in "errored" state, rounded to two decimal places
 *   - oldestStuckAt: ISO-8601 creation date of the oldest stream currently marked "errored" or "stuck"
 *   - checkedAt: timestamp of execution
 *
 * Security:
 *   - Gated behind requireAdmin authentication from admin-guard (Actor-Wallet-Address or verified JWT token)
 *
 * Logging & Observability:
 *   - Establishes AsyncLocalStorage correlation context from request headers
 *   - Emits structured JSON logs containing correlation and request metadata
 */

import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { requireAdmin } from "@/app/lib/admin-guard";
import {
  extractCorrelationContext,
  getCorrelationContext,
  logger,
  withCorrelationContext,
} from "@/app/lib/logger";

/**
 * Constructs a standardized JSON error response including the request correlation ID.
 */
function errorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: context?.request_id ?? "unknown-request-id",
      },
    },
    { status },
  );
}

export async function GET(request: Request) {
  // Extract and propagate W3C/x-correlation headers for structured logging
  const correlationContext = extractCorrelationContext(new Headers(request.headers));

  return withCorrelationContext(correlationContext, async () => {
    logger.info("Admin streams health check requested");

    // Enforce admin verification
    const authResult = requireAdmin(request);
    if (authResult instanceof NextResponse) {
      logger.warn("Admin streams health check rejected: unauthorized");
      // Return a standardized 403 Forbidden with custom envelope
      return errorResponse("FORBIDDEN", "Admin authorization required.", 403);
    }

    try {
      const { streamRepository } = getStore();
      if (!streamRepository || !streamRepository.streams) {
        logger.error("Streams repository not initialized or unavailable");
        return errorResponse("INTERNAL_SERVER_ERROR", "Data store unavailable.", 500);
      }

      const streams = Array.from(streamRepository.streams.values());

      const counts: Record<string, number> = {};
      let oldestStuckAt: string | null = null;

      for (const s of streams) {
        const status = s.status ?? "unknown";
        counts[status] = (counts[status] ?? 0) + 1;

        if (status === "errored" || status === "stuck") {
          const createdAt = s.createdAt ?? "";
          if (createdAt) {
            if (!oldestStuckAt || createdAt < oldestStuckAt) {
              oldestStuckAt = createdAt;
            }
          }
        }
      }

      const total = streams.length;
      const errored = counts["errored"] ?? 0;
      const failureRatePct = total > 0 ? Math.round((errored / total) * 10000) / 100 : 0;

      logger.info("Admin streams health check completed successfully", {
        total_streams: total,
        failure_rate_pct: failureRatePct,
        has_stuck_streams: !!oldestStuckAt,
      });

      return NextResponse.json({
        data: {
          health: {
            total,
            byStatus: counts,
            failureRatePct,
            oldestStuckAt,
            checkedAt: new Date().toISOString(),
          },
        },
      });
    } catch (err: any) {
      logger.error("Admin streams health check failed with unexpected error", {
        error: err.message || String(err),
        stack: err.stack,
      });
      return errorResponse("INTERNAL_SERVER_ERROR", "An unexpected error occurred.", 500);
    }
  });
}
