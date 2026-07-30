/**
 * Webhook health status logic.
 *
 * Extracted from app/api/webhooks/health/route.ts because Next.js route files
 * only permit HTTP method exports (GET, POST, etc.) — exporting utility
 * functions or types from a route file breaks `next build`.
 */

export interface WebhookSubscriptionStats {
  total: number;
  active: number;
  degraded: number;
  disabled: number;
}

export interface WebhookDeliveryStats {
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  dlq: number;
  /** Percentage of deliveries that succeeded (0–100). */
  success_rate_pct: number;
}

export interface WebhookHealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  checked_at: string;
  subscriptions: WebhookSubscriptionStats;
  delivery_stats: WebhookDeliveryStats;
}

/**
 * Derive an overall health status from subscription and delivery stats.
 *
 * Rules:
 * - "unhealthy" when more than 50 % of subscriptions are degraded/disabled
 * - "degraded"  when any subscriptions are degraded or DLQ depth > 0
 * - "ok"        otherwise
 */
export function deriveHealthStatus(
  subs: WebhookSubscriptionStats,
  stats: WebhookDeliveryStats,
): WebhookHealthResponse["status"] {
  const degradedRatio =
    subs.total > 0 ? (subs.degraded + subs.disabled) / subs.total : 0;
  if (degradedRatio > 0.5) return "unhealthy";
  if (subs.degraded > 0 || stats.dlq > 0) return "degraded";
  return "ok";
}
