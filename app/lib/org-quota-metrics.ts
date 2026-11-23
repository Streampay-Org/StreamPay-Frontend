/**
 * org-quota-metrics.ts
 *
 * Lightweight in-process metrics for org daily and configured stream quota rejections.
 *
 * Mirrors the shape of rate-limit-metrics.ts so dashboards and log-scrapers
 * can consume both quota types.
 *
 * In production, replace the console.warn call with your observability
 * pipeline (e.g. emit a CloudWatch metric or push to a StatsD client).
 */

interface QuotaRejectionEvent {
  orgId: string;
  timestamp: string;
}

interface CreationQuotaRejectionEvent {
  scope: "org" | "user";
  subject: string;
  code: string;
  timestamp: string;
}

/** Total rejections per orgId. */
const rejectionCounters = new Map<string, number>();
const creationRejectionCounters = new Map<string, number>();

/** Ring buffer of the 100 most recent rejection events. */
const recentRejections: QuotaRejectionEvent[] = [];
const recentCreationRejections: CreationQuotaRejectionEvent[] = [];
const MAX_RECENT = 100;

/**
 * Records a single quota rejection for the given org.
 * Increments the counter, appends to the ring buffer, and emits a
 * structured log line for log-based alerting.
 */
export function recordOrgQuotaRejection(orgId: string): void {
  rejectionCounters.set(orgId, (rejectionCounters.get(orgId) ?? 0) + 1);

  const event: QuotaRejectionEvent = {
    orgId,
    timestamp: new Date().toISOString(),
  };

  recentRejections.push(event);
  if (recentRejections.length > MAX_RECENT) {
    recentRejections.shift();
  }

  // Structured log — consumed by log-based alerting and metrics pipelines.
  console.warn(
    JSON.stringify({
      event: "org_daily_quota_exceeded",
      orgId,
      timestamp: event.timestamp,
    }),
  );
}

/** Records a user- or org-configured stream-creation quota rejection. */
export function recordCreationQuotaRejection(
  scope: "org" | "user",
  subject: string,
  code: string,
): void {
  const key = `${scope}:${subject}:${code}`;
  creationRejectionCounters.set(key, (creationRejectionCounters.get(key) ?? 0) + 1);

  const event: CreationQuotaRejectionEvent = {
    scope,
    subject,
    code,
    timestamp: new Date().toISOString(),
  };
  recentCreationRejections.push(event);
  if (recentCreationRejections.length > MAX_RECENT) {
    recentCreationRejections.shift();
  }

  console.warn(JSON.stringify({ event: "stream_creation_quota_exceeded", ...event }));
}

/** Returns a snapshot of configured stream-creation quota rejections. */
export function getCreationQuotaMetrics(): {
  rejections: Record<string, number>;
  recentRejections: CreationQuotaRejectionEvent[];
} {
  return {
    rejections: Object.fromEntries(creationRejectionCounters),
    recentRejections: [...recentCreationRejections],
  };
}

/** Returns a snapshot of all quota-rejection metrics. */
export function getOrgQuotaMetrics(): {
  rejections: Record<string, number>;
  recentRejections: QuotaRejectionEvent[];
} {
  return {
    rejections: Object.fromEntries(rejectionCounters),
    recentRejections: [...recentRejections],
  };
}

/** Resets all counters and the ring buffer. Use in tests' beforeEach. */
export function resetOrgQuotaMetrics(): void {
  rejectionCounters.clear();
  recentRejections.length = 0;
  creationRejectionCounters.clear();
  recentCreationRejections.length = 0;
}
