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

/**
 * GET /api/webhooks/health
 *
 * Returns the health status of the webhook delivery system along with
 * per-subscription delivery statistics.
 *
 * Supports request correlation tracking and structured logging.
 */
export async function GET(request?: Request | NextRequest) {
  const reqHeaders = request?.headers ?? new Headers();
  const context = extractCorrelationContext(reqHeaders);

  return withCorrelationContext(context, async () => {
    try {
      // TODO: replace stubs with real data-layer queries once persistence is wired up.
      const subscriptions: WebhookSubscriptionStats = {
        total: 0,
        active: 0,
        degraded: 0,
        disabled: 0,
      };

      const delivery_stats: WebhookDeliveryStats = {
        total: 0,
        delivered: 0,
        failed: 0,
        pending: 0,
        dlq: 0,
        success_rate_pct: 100,
      };

      const status = deriveHealthStatus(subscriptions, delivery_stats);
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
        dlq_depth: delivery_stats.dlq,
      });

      return NextResponse.json(body, { status: 200 });
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

