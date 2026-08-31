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

// ── /api/auth/wallet metrics ─────────────────────────────────────────────────
//
// Per-endpoint metrics for the wallet authentication endpoint. Two handlers
// live behind a single path:
//
//   GET  /api/auth/wallet  → issues a one-time challenge ("challenge")
//   POST /api/auth/wallet  → verifies a wallet signature ("verify")
//
// Both are recorded with the same metric names so a Grafana dashboard can
// graph "requests by operation" or "p99 latency for verify failures" without
// having to know the underlying HTTP method.
//
// Label cardinality:
//   method     — 2 values (GET, POST), bounded.
//   operation  — 2 values (challenge, verify), bounded.
//   status     — small bounded set of HTTP status codes returned by the route.
// Cardinality stays bounded so Prometheus TSDB does not blow up.
export const walletAuthCounter = new Counter({
  name: 'wallet_auth_requests_total',
  help: 'Total number of /api/auth/wallet requests received, partitioned by HTTP method, semantic operation, and response status.',
  labelNames: ['method', 'operation', 'status'],
  registers: [registry],
});

export const walletAuthDuration = new Histogram({
  name: 'wallet_auth_request_duration_seconds',
  help: 'Histogram of /api/auth/wallet request processing duration in seconds, partitioned by HTTP method, semantic operation, and response status.',
  labelNames: ['method', 'operation', 'status'],
  // Buckets sized for the wallet endpoint's 5 s per-request deadline plus
  // headroom for the 429 rate-limit fast-path which is sub-millisecond.
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
