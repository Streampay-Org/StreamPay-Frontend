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
export const rateLimitStoreUnavailable = new Counter({
  name: 'rate_limit_store_unavailable_total',
  help: 'Total number of times the shared Redis rate-limit store was unavailable',
  registers: [registry],
});
