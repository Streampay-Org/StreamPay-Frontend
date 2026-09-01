import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@/app/lib/errors/server";
import { withTimeout, WEBHOOK_TIMEOUT_MS } from "@/src/middleware/timeout";
import {
  extractCorrelationContext,
  logger,
  withCorrelationContext,
} from "@/app/lib/logger";
import {
  deriveHealthStatus,
  type WebhookDeliveryStats,
  type WebhookHealthResponse,
  type WebhookSubscriptionStats,
} from "./health";

type WebhookDeliveryStatsWithStale = WebhookDeliveryStats & { stale: number };

export async function GET(request?: Request | NextRequest) {
  const reqHeaders = request?.headers ?? new Headers();
  const context = extractCorrelationContext(reqHeaders);

  return withCorrelationContext(context, async () => {
    try {
      return await withTimeout(
        (async () => {
          // TODO: Replace placeholder counts with real data-layer queries.
          // The stale count must be derived from pending deliveries whose last
          // attempt is older than WEBHOOK_TIMEOUT_MS. This is critical to
          // distinguish stale (potentially stuck) deliveries from hard failures.
          const subscriptions: WebhookSubscriptionStats = {
            total: 0,
            active: 0,
            degraded: 0,
            disabled: 0,
          };

          const delivery_stats: WebhookDeliveryStatsWithStale = {
            total: 0,
            delivered: 0,
            failed: 0,
            pending: 0,
            dlq: 0,
            stale: 0,
            success_rate_pct: 100,
          };

          const baseStatus = deriveHealthStatus(subscriptions, delivery_stats);
          // Distinguish stale deliveries from failed ones: a stale delivery is
          // a pending delivery that exceeded WEBHOOK_TIMEOUT_MS. It should mark
          // the system degraded even if no hard failures have occurred.
          const status: WebhookHealthResponse["status"] =
            delivery_stats.stale > 0 && baseStatus === "healthy"
              ? "degraded"
              : baseStatus;

          const checked_at = new Date().toISOString();

          const body: WebhookHealthResponse = {
            status,
            checked_at,
            subscriptions,
            delivery_stats,
          };

          logger.info("Webhook health stats retrieved", {
            status,
            total_subscriptions: subscriptions.total,
            stale_count: delivery_stats.stale,
            dlq_depth: delivery_stats.dlq,
          });

          return NextResponse.json(body, { status: 200 });
        })(),
        WEBHOOK_TIMEOUT_MS,
      );
    } catch (error) {
      try {
        logger.error("Failed to retrieve webhook health stats", { error });
      } catch {
        // Fall through if logger fails (e.g., clock/formatting error)
      }
      return errorResponse(
        ErrorCode.INTERNAL_SERVER_ERROR,
        "Failed to retrieve webhook health stats.",
        500,
      );
    }
  });
}
