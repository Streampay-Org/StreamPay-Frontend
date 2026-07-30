export const RATE_LIMITS = {
  read: { limit: 60, windowMs: 60_000 },
  write: { limit: 10, windowMs: 60_000 },
  export: { limit: 5, windowMs: 60_000 },
  /**
   * Per-user limit for the public reconciliation overview endpoint
   * (`GET /api/reconciliation`).  30 requests per minute is generous enough
   * for polling dashboards while still protecting the endpoint from abuse.
   * Override via `RECONCILIATION_RATE_LIMIT` environment variable.
   */
  reconciliation: {
    limit: Number(process.env.RECONCILIATION_RATE_LIMIT ?? 30),
    windowMs: 60_000,
  },
  /**
   * Per-user limit for webhook ingest + metrics scrape
   * (`GET|POST /api/webhooks`).  30 requests per minute protects the
   * public receiver from abuse while remaining usable for legitimate
   * delivery bursts. Override via `WEBHOOK_RATE_LIMIT`.
   */
  webhook: {
    limit: Number(process.env.WEBHOOK_RATE_LIMIT ?? 30),
    windowMs: 60_000,
  },
} as const;

export type LimitType = keyof typeof RATE_LIMITS;

/**
 * Per-org daily stream creation quota (org:streams_per_day window).
 *
 * `limit`    — maximum streams an org may create in a single UTC calendar day.
 * `windowMs` — informational: the window is always one UTC day (86 400 000 ms),
 *              kept here for documentation parity with RATE_LIMITS.
 *
 * Override `limit` via the ORG_DAILY_STREAM_QUOTA_LIMIT environment variable
 * so operators can tune the cap without a code deploy.
 */
export const ORG_DAILY_STREAM_QUOTA = {
  limit: Number(process.env.ORG_DAILY_STREAM_QUOTA_LIMIT ?? 100),
  windowMs: 24 * 60 * 60_000, // 24 h — window is one UTC calendar day
} as const;

export const ROUTE_LIMITS: Record<string, LimitType> = {
  "GET:/api/reconciliation": "reconciliation",
  "GET:/api/webhooks": "webhook",
  "POST:/api/webhooks": "webhook",
  "GET:/api/streams": "read",
  "GET:/api/streams/": "read",
  "GET:/api/activity": "read",
  "GET:/api/identity/me": "read",
  "POST:/api/streams": "write",
  "POST:/api/streams/batch": "write",
  "DELETE:/api/streams/": "write",
  "POST:/api/streams/*/start": "write",
  "POST:/api/streams/*/pause": "write",
  "POST:/api/streams/*/stop": "write",
  "POST:/api/streams/*/settle": "write",
  "POST:/api/streams/*/withdraw": "write",
  "POST:/api/streams/*/webhooks/test": "write",
  "POST:/api/exports": "export",
};

export const STORE_TYPE = process.env.RATE_LIMIT_STORE_TYPE || "in-memory";

export function getLimitForRoute(method: string, path: string): LimitType {
  const exactKey = `${method}:${path}`;
  if (ROUTE_LIMITS[exactKey]) {
    return ROUTE_LIMITS[exactKey];
  }

  // Handle wildcards in the middle: /api/streams/123/start -> /api/streams/*/start
  const middleWildcardKey = `${method}:${path.replace(/\/streams\/[^/]+\//, "/streams/*/")}`;
  if (ROUTE_LIMITS[middleWildcardKey]) {
    return ROUTE_LIMITS[middleWildcardKey];
  }

  // Handle wildcards at the end: /api/streams/123 -> /api/streams/*
  const endWildcardKey = `${method}:${path.replace(/\/[^/]+$/, "/*")}`;
  if (ROUTE_LIMITS[endWildcardKey]) {
    return ROUTE_LIMITS[endWildcardKey];
  }

  return method === "GET" ? "read" : "write";
}
