import { NextRequest, NextResponse } from "next/server";
import { errorResponse, ErrorCode } from "@app/lib/errors/server";
import { withTimeout, WEBHOOK_TIMEOUT_MS } from "@src/middleware/timeout";
import {
  extractCorrelationContext,
  logger,
  withCorrelationContext,
} from "@app/lib/logger";
import { getWebhookSubscriptionStore } from "@app/lib/webhook-store";
import { webhookDeliveryStore } from "@app/lib/webhook-delivery-store";
import {
  computeSuccessRatePct,
  deriveHealthStatus,
  getSubscriptionStats,
  type WebhookDeliveryStats,
  type WebhookHealthResponse,
} from "./health";

type WebhookDeliveryStatsWithStale = WebhookDeliveryStats & { stale: number };

export async function GET(request?: Request | NextRequest) {
  const reqHeaders = request?.headers ?? new Headers();
  const context = extractCorrelationContext(reqHeaders);

  return withCorrelationContext(context, async () => {
    try {
      return await withTimeout(
        WEBHOOK_TIMEOUT_MS,
        request ?? {},
        async () => {
          const now = new Date();
          const subscriptions = await getSubscriptionStats(
            getWebhookSubscriptionStore(),
            webhookDeliveryStore,
          );
          const rawStats = webhookDeliveryStore.getDeliveryHealthStats(
            now,
            WEBHOOK_TIMEOUT_MS,
          );

          const delivery_stats: WebhookDeliveryStatsWithStale = {
            ...rawStats,
            success_rate_pct: computeSuccessRatePct(
              rawStats.delivered,
              rawStats.failed,
              rawStats.dlq,
            ),
          };

          const baseStatus = deriveHealthStatus(subscriptions, delivery_stats);
          // Distinguish stale deliveries from failed ones: a stale delivery is
          // a pending delivery that exceeded WEBHOOK_TIMEOUT_MS. It should mark
          // the system degraded even if no hard failures have occurred.
          const status: WebhookHealthResponse["status"] =
            delivery_stats.stale > 0 && baseStatus === "ok"
              ? "degraded"
              : baseStatus;

          const checked_at = now.toISOString();

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
        },
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
