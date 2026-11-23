import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
  CounterConfiguration,
  HistogramConfiguration,
} from 'prom-client';

const globalForMetrics = globalThis as unknown as {
  __streampayRegistry?: Registry;
  __streampayDefaultMetricsRegistered?: boolean;
};

export const registry: Registry = (globalForMetrics.__streampayRegistry ??= new Registry());

if (!globalForMetrics.__streampayDefaultMetricsRegistered) {
  collectDefaultMetrics({ register: registry });
  globalForMetrics.__streampayDefaultMetricsRegistered = true;
}

export function getOrCreateCounter<T extends string = string>(
  name: string,
  cfg: Omit<CounterConfiguration<T>, 'name' | 'registers'> & {
    name?: string;
    registers?: Registry[];
  },
): Counter<T> {
  const existing = registry.getSingleMetric(name);
  if (existing) {
    return existing as Counter<T>;
  }
  return new Counter<T>({
    ...cfg,
    name,
    registers: [registry],
  });
}

export function getOrCreateHistogram<T extends string = string>(
  name: string,
  cfg: Omit<HistogramConfiguration<T>, 'name' | 'registers'> & {
    name?: string;
    registers?: Registry[];
  },
): Histogram<T> {
  const existing = registry.getSingleMetric(name);
  if (existing) {
    return existing as Histogram<T>;
  }
  return new Histogram<T>({
    ...cfg,
    name,
    registers: [registry],
  });
}

// ── /api/webhooks metrics ────────────────────────────────────────────────────

export const webhookCounter = getOrCreateCounter('webhook_requests_total', {
  help: 'Total number of webhook requests received',
  labelNames: ['status', 'event_type'],
});

export const webhookDuration = getOrCreateHistogram('webhook_request_duration_seconds', {
  help: 'Histogram of webhook request processing duration in seconds',
  labelNames: ['status', 'event_type'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

// ── /api/exports metrics ────────────────────────────────────────────────────

export const exportCounter = getOrCreateCounter('export_requests_total', {
  help: 'Total number of /api/exports requests',
  labelNames: ['status', 'method'],
});

export const exportDuration = getOrCreateHistogram('export_request_duration_seconds', {
  help: 'Histogram of /api/exports request processing duration in seconds',
  labelNames: ['status', 'method'],
  buckets: [0.1, 0.5, 1, 2, 5, 15],
});

// ── /api/reconciliation metrics ─────────────────────────────────────────────

export const reconciliationCounter = getOrCreateCounter('api_reconciliation_requests_total', {
  help: 'Total number of /api/reconciliation requests received',
  labelNames: ['status'],
});

export const reconciliationDuration = getOrCreateHistogram('api_reconciliation_request_duration_seconds', {
  help: 'Histogram of /api/reconciliation request processing duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

// ── /api/auth/wallet metrics ─────────────────────────────────────────────────

export const walletAuthCounter = getOrCreateCounter('wallet_auth_requests_total', {
  help: 'Total number of /api/auth/wallet requests',
  labelNames: ['method', 'operation', 'status'],
});

export const walletAuthDuration = getOrCreateHistogram('wallet_auth_request_duration_seconds', {
  help: 'Histogram of /api/auth/wallet request duration in seconds',
  labelNames: ['method', 'operation', 'status'],
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// ── /api/streams metrics ─────────────────────────────────────────────────────

export const streamsCounter = getOrCreateCounter('api_streams_requests_total', {
  help: 'Total number of /api/streams requests',
  labelNames: ['method', 'status'],
});

export const streamsDuration = getOrCreateHistogram('api_streams_request_duration_seconds', {
  help: 'Histogram of /api/streams request duration in seconds',
  labelNames: ['method', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5],
});

/** Record a /api/streams request; `start` is a `process.hrtime()` tuple. */
export function observeStreamsRequest(method: string, status: number, start: [number, number]): void {
  const labels = { method, status: String(status) };
  streamsCounter.inc(labels);
  const diff = process.hrtime(start);
  streamsDuration.observe(labels, diff[0] + diff[1] / 1e9);
}

// ── Rate-limit store health ──────────────────────────────────────────────────

/**
 * Incremented each time the shared Redis rate-limit store is unreachable
 * (timeout, 5xx, network error).  When this spikes, the app is falling back
 * to fail-open or the local shadow bucket.
 */
export const rateLimitStoreUnavailable = getOrCreateCounter('rate_limit_store_unavailable_total', {
  help: 'Total number of times the shared Redis rate-limit store was unavailable',
});

// ── /api/internal/jobs/settle-ended metrics ──────────────────────────────────

export const settleJobRunsCounter = getOrCreateCounter('settle_job_runs_total', {
  help: 'Total number of settle-ended internal job runs',
  labelNames: ['dry_run'],
});

export const settleJobStreamsCounter = getOrCreateCounter('settle_job_streams_total', {
  help: 'Total number of streams processed by the settle-ended internal job',
  labelNames: ['result'],
});

// ── Generic HTTP request duration histogram ──────────────────────────────────

export const HTTP_REQUEST_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export const httpRequestDuration = getOrCreateHistogram('http_request_duration_seconds', {
  help: 'Histogram of HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_class'],
  buckets: HTTP_REQUEST_DURATION_BUCKETS,
});

/**
 * Bounded set of canonical API route templates.
 * Dynamic segments are represented as `:id` so label cardinality stays bounded.
 */
const KNOWN_ROUTE_TEMPLATES = new Set<string>([
  '/api/activity',
  '/api/admin/circuit-breaker',
  '/api/admin/jobs',
  '/api/admin/pause',
  '/api/admin/pause-by-sender',
  '/api/admin/quotas',
  '/api/admin/quotas/:id',
  '/api/admin/rotate',
  '/api/admin/streams/health',
  '/api/admin/upgrade',
  '/api/admin/webhooks/redeliver',
  '/api/audit',
  '/api/audit/archive',
  '/api/audit/export',
  '/api/auth/logout',
  '/api/auth/wallet',
  '/api/auth/wallet/health',
  '/api/debug/kms-sign',
  '/api/exports',
  '/api/exports/health',
  '/api/exports/:id',
  '/api/healthz',
  '/api/identity/me',
  '/api/identity/me/delete',
  '/api/indexer/sse',
  '/api/indexer/status',
  '/api/internal/cleanup/idempotency',
  '/api/internal/jobs/settle-ended',
  '/api/internal/reconciliation',
  '/api/internal/reconciliation/diff/:id',
  '/api/internal/reconciliation/nightly',
  '/api/metrics',
  '/api/notifications/preferences',
  '/api/orgs',
  '/api/orgs/:id',
  '/api/orgs/:id/audit',
  '/api/orgs/:id/members',
  '/api/orgs/:id/policy',
  '/api/orgs/:id/token-allowlist',
  '/api/readyz',
  '/api/reconciliation',
  '/api/reconciliation/health',
  '/api/streams',
  '/api/streams/batch',
  '/api/streams/batch/start',
  '/api/streams/batch/stop',
  '/api/streams/dryrun',
  '/api/streams/events',
  '/api/streams/health',
  '/api/streams/import',
  '/api/streams/preview',
  '/api/streams/search',
  '/api/streams/stats',
  '/api/streams/template',
  '/api/streams/:id',
  '/api/streams/:id/approvals',
  '/api/streams/:id/approvals/:id/approve',
  '/api/streams/:id/cancel',
  '/api/streams/:id/cancel/preview',
  '/api/streams/:id/events',
  '/api/streams/:id/history',
  '/api/streams/:id/pause',
  '/api/streams/:id/settle',
  '/api/streams/:id/settle/preview',
  '/api/streams/:id/start',
  '/api/streams/:id/stop',
  '/api/streams/:id/webhooks/test',
  '/api/streams/:id/withdraw',
  '/api/streams/:id/withdraw/preview',
  '/api/v2/streams',
  '/api/v2/streams/batch',
  '/api/v2/streams/multi',
  '/api/v2/streams/multi/:id',
  '/api/v2/streams/multi/:id/pause',
  '/api/v2/streams/multi/:id/start',
  '/api/v2/streams/multi/:id/stop',
  '/api/v2/streams/:id',
  '/api/webhooks',
  '/api/webhooks/deliveries',
  '/api/webhooks/dlq',
  '/api/webhooks/dlq/:id/replay',
  '/api/webhooks/health',
  '/api/webhooks/rotate',
  '/api/webhooks/subscriptions',
]);

const DYNAMIC_ROUTE_PATTERNS: Array<{ template: string; segments: string[] }> = Array.from(
  KNOWN_ROUTE_TEMPLATES,
)
  .filter((template) => template.includes(':id'))
  .map((template) => ({ template, segments: template.split('/') }));

/**
 * Pure function that normalizes a raw URL path or route template into a
 * bounded route label (e.g. `/api/streams/abc123` -> `/api/streams/:id`,
 * `/api/streams/[id]` -> `/api/streams/:id`). Unknown routes are grouped as
 * `unmatched` so label cardinality stays bounded.
 */
export function normalizeRoute(path: string): string {
  if (!path || typeof path !== 'string') {
    return 'unmatched';
  }

  // Strip query string and fragment, collapse duplicate slashes, trim trailing slash.
  let cleaned = path.split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/');
  if (cleaned.length > 1 && cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1);
  }
  if (!cleaned.startsWith('/')) {
    return 'unmatched';
  }

  // Normalize Next.js bracket params (`[id]`, `[orgId]`) and `:param` placeholders to `:id`.
  const templateNormalized = cleaned
    .split('/')
    .map((seg) => (/^\[[^\]]+\]$/.test(seg) || /^:[^/]+$/.test(seg) ? ':id' : seg))
    .join('/');

  if (KNOWN_ROUTE_TEMPLATES.has(templateNormalized)) {
    return templateNormalized;
  }

  // Match raw paths against known dynamic route templates (static routes already matched above).
  const segments = templateNormalized.split('/');
  for (const candidate of DYNAMIC_ROUTE_PATTERNS) {
    if (candidate.segments.length !== segments.length) continue;
    let matched = true;
    for (let i = 0; i < segments.length; i++) {
      if (candidate.segments[i] !== ':id' && candidate.segments[i] !== segments[i]) {
        matched = false;
        break;
      }
      if (candidate.segments[i] === ':id' && segments[i].length === 0) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return candidate.template;
    }
  }

  return 'unmatched';
}

function toStatusClass(status: number): string {
  if (!Number.isFinite(status)) return '5xx';
  const group = Math.floor(status / 100);
  if (group >= 1 && group <= 5) {
    return `${group}xx`;
  }
  return 'unknown';
}

/**
 * Record an HTTP request duration observation on `http_request_duration_seconds`.
 */
export function observeHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  const normalizedMethod = (method || 'UNKNOWN').toUpperCase();
  const normalizedRoute = normalizeRoute(route);
  const statusClass = toStatusClass(status);
  const safeDuration =
    Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0;

  httpRequestDuration.observe(
    {
      method: normalizedMethod,
      route: normalizedRoute,
      status_class: statusClass,
    },
    safeDuration,
  );
}
