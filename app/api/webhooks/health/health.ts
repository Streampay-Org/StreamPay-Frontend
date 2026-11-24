/**
 * Webhook delivery health helpers shared by the route handler and unit tests.
 * Re-exported from `@app/lib/webhook-health` so there is a single source of truth.
 */

export {
  DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD,
  computeSuccessRatePct,
  deriveHealthStatus,
  getSubscriptionStats,
  type WebhookDeliveryStats,
  type WebhookHealthResponse,
  type WebhookSubscriptionStats,
} from "@app/lib/webhook-health";
