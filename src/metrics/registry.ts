import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();

// Optional: collect default nodejs metrics (CPU, memory, etc.)
collectDefaultMetrics({ register: registry });

// ── /api/webhooks metrics ────────────────────────────────────────────────────

export const webhookCounter = new Counter({
  name: 'webhook_requests_total',
  help: 'Total number of webhook requests received',
  labelNames: ['status', 'event_type'],
  registers: [registry],
});

export const webhookDuration = new Histogram({
  name: 'webhook_request_duration_seconds',
  help: 'Histogram of webhook request processing duration in seconds',
  labelNames: ['status', 'event_type'],
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

export const reconciliationCounter = new Counter({
  name: 'api_reconciliation_requests_total',
  help: 'Total number of /api/reconciliation requests received',
  labelNames: ['status'],
  registers: [registry],
});

export const reconciliationDuration = new Histogram({
  name: 'api_reconciliation_request_duration_seconds',
  help: 'Histogram of /api/reconciliation request processing duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [registry],
});
