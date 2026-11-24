/**
 * Webhook health status logic.
 *
 * Single source of truth for webhook health types, status derivation,
 * subscription health aggregation, and delivery success-rate calculation.
 * Kept outside route.ts so Next.js route-type checks stay clean.
 */

import type { PostgresWebhookSubscriptionStore } from "./webhook-store";
import {
  webhookDeliveryStore,
  type WebhookDeliveryStore,
} from "./webhook-delivery-store";

/**
 * Number of consecutive recent finalised delivery failures (`failed` or `dlq`)
 * for an active subscription's endpoint before the subscription is classified
 * as `degraded`.
 */
export const DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD = 3;

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
  /** Pending deliveries whose last attempt (or creation time) exceeded WEBHOOK_TIMEOUT_MS. */
  stale?: number;
  /** Percentage of finalised deliveries that succeeded (0–100). */
  success_rate_pct: number;
}

export interface WebhookHealthResponse {
  status: "ok" | "degraded" | "unhealthy";
  checked_at: string;
  subscriptions: WebhookSubscriptionStats;
  delivery_stats: WebhookDeliveryStats;
}

/**
 * Compute delivery success rate percentage as
 * `delivered / (delivered + failed + dlq) * 100`, rounded to 2 decimal places.
 * Returns `100` when there are no finalised deliveries.
 */
export function computeSuccessRatePct(
  delivered: number,
  failed: number,
  dlq: number,
): number {
  const finalized = delivered + failed + dlq;
  if (finalized === 0) return 100;
  return Math.round((delivered / finalized) * 10000) / 100;
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

type SubscriptionLister = Pick<PostgresWebhookSubscriptionStore, "list">;
type EndpointDeliveryReader = Pick<
  WebhookDeliveryStore,
  "getDeliveriesByEndpoint"
>;

/**
 * Aggregate subscription counts from the subscription store.
 *
 * - `inactive` subscriptions are counted as `disabled`.
 * - `active` subscriptions whose endpoint has at least
 *   {@link DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD} consecutive recent finalised
 *   failures (`failed` or `dlq`) are counted as `degraded`.
 * - All other `active` subscriptions are counted as `active`.
 */
export async function getSubscriptionStats(
  store: SubscriptionLister,
  deliveryStore: EndpointDeliveryReader = webhookDeliveryStore,
): Promise<WebhookSubscriptionStats> {
  const subscriptions = await store.list();

  let active = 0;
  let degraded = 0;
  let disabled = 0;

  for (const sub of subscriptions) {
    if (sub.status === "inactive") {
      disabled += 1;
      continue;
    }

    const finalised = deliveryStore
      .getDeliveriesByEndpoint(sub.id)
      .filter((d) => d.status !== "pending")
      .sort((a, b) => {
        const tsA = a.finalizedAt ?? a.updatedAt ?? a.createdAt;
        const tsB = b.finalizedAt ?? b.updatedAt ?? b.createdAt;
        const cmp = tsB.localeCompare(tsA);
        return cmp !== 0 ? cmp : b.deliveryId.localeCompare(a.deliveryId);
      });

    let consecutiveFailures = 0;
    for (const delivery of finalised) {
      if (delivery.status === "failed" || delivery.status === "dlq") {
        consecutiveFailures += 1;
      } else {
        break;
      }
    }

    if (consecutiveFailures >= DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD) {
      degraded += 1;
    } else {
      active += 1;
    }
  }

  return {
    total: subscriptions.length,
    active,
    degraded,
    disabled,
  };
}
