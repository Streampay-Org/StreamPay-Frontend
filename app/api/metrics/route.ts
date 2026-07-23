import { NextResponse } from "next/server";
import { requireInternalServiceAuth } from "@/app/lib/internal-service-auth";
import { getStore } from "@/app/lib/db";

/**
 * Prometheus metrics endpoint
 * 
 * This endpoint provides application metrics in Prometheus format for monitoring and observability.
 * It is token-gated using internal service authentication to prevent unauthorized access.
 * 
 * Metrics exposed:
 * - streampay_streams_total: Total number of streams
 * - streampay_streams_active: Number of active streams
 * - streampay_streams_ended: Number of ended streams
 * - streampay_streams_paused: Number of paused streams
 * - streampay_streams_withdrawn: Number of withdrawn streams
 * - streampay_streams_draft: Number of draft streams
 * - streampay_failed_withdrawals_total: Total number of failed withdrawals
 * 
 * Authentication:
 * Requires internal service authentication with HMAC signature.
 * Allowed services: prometheus, monitoring, ops-automation
 * 
 * @returns Prometheus-formatted metrics text/plain
 */
export async function GET(request: Request) {
  // Require internal service authentication
  const identity = await requireInternalServiceAuth(request, {
    allowedServices: ["prometheus", "monitoring", "ops-automation"],
    concealFailure: false,
  });

  if (identity instanceof NextResponse) {
    return identity;
  }

  // Generate correlation ID for logging
  const correlationId = generateCorrelationId();

  try {
    const { streamRepository } = getStore();
    const streams = Array.from(streamRepository.streams.values());

    // Calculate metrics
    const metrics = {
      totalStreams: streams.length,
      activeStreams: streams.filter((s) => s.status === "active").length,
      endedStreams: streams.filter((s) => s.status === "ended").length,
      pausedStreams: streams.filter((s) => s.status === "paused").length,
      withdrawnStreams: streams.filter((s) => s.status === "withdrawn").length,
      draftStreams: streams.filter((s) => s.status === "draft").length,
      failedWithdrawals: streams.filter((s) => s.withdrawal?.state === "failed").length,
    };

    // Format as Prometheus metrics
    const prometheusMetrics = formatPrometheusMetrics(metrics, correlationId);

    // Log structured metrics access
    logMetricsAccess({
      correlationId,
      serviceName: identity.serviceName,
      keyId: identity.keyId,
      metrics,
    });

    return new NextResponse(prometheusMetrics, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4",
        "X-Correlation-ID": correlationId,
      },
    });
  } catch (error) {
    // Log error with correlation ID
    logMetricsError({
      correlationId,
      serviceName: identity.serviceName,
      keyId: identity.keyId,
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        error: {
          code: "METRICS_ERROR",
          message: "Failed to generate metrics",
          request_id: correlationId,
        },
      },
      { status: 500 }
    );
  }
}

/**
 * Formats metrics in Prometheus exposition format
 */
function formatPrometheusMetrics(
  metrics: {
    totalStreams: number;
    activeStreams: number;
    endedStreams: number;
    pausedStreams: number;
    withdrawnStreams: number;
    draftStreams: number;
    failedWithdrawals: number;
  },
  correlationId: string
): string {
  const timestamp = Math.floor(Date.now() / 1000);

  const lines = [
    `# HELP streampay_streams_total Total number of streams in the system`,
    `# TYPE streampay_streams_total gauge`,
    `streampay_streams_total{correlation_id="${correlationId}"} ${metrics.totalStreams} ${timestamp}`,
    "",
    `# HELP streampay_streams_active Number of active streams`,
    `# TYPE streampay_streams_active gauge`,
    `streampay_streams_active{correlation_id="${correlationId}"} ${metrics.activeStreams} ${timestamp}`,
    "",
    `# HELP streampay_streams_ended Number of ended streams`,
    `# TYPE streampay_streams_ended gauge`,
    `streampay_streams_ended{correlation_id="${correlationId}"} ${metrics.endedStreams} ${timestamp}`,
    "",
    `# HELP streampay_streams_paused Number of paused streams`,
    `# TYPE streampay_streams_paused gauge`,
    `streampay_streams_paused{correlation_id="${correlationId}"} ${metrics.pausedStreams} ${timestamp}`,
    "",
    `# HELP streampay_streams_withdrawn Number of withdrawn streams`,
    `# TYPE streampay_streams_withdrawn gauge`,
    `streampay_streams_withdrawn{correlation_id="${correlationId}"} ${metrics.withdrawnStreams} ${timestamp}`,
    "",
    `# HELP streampay_streams_draft Number of draft streams`,
    `# TYPE streampay_streams_draft gauge`,
    `streampay_streams_draft{correlation_id="${correlationId}"} ${metrics.draftStreams} ${timestamp}`,
    "",
    `# HELP streampay_failed_withdrawals_total Total number of failed withdrawals`,
    `# TYPE streampay_failed_withdrawals_total gauge`,
    `streampay_failed_withdrawals_total{correlation_id="${correlationId}"} ${metrics.failedWithdrawals} ${timestamp}`,
  ];

  return lines.join("\n");
}

/**
 * Generates a correlation ID for request tracking
 */
function generateCorrelationId(): string {
  return `metrics_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Logs metrics access for audit trail
 */
function logMetricsAccess(data: {
  correlationId: string;
  serviceName: string;
  keyId: string;
  metrics: {
    totalStreams: number;
    activeStreams: number;
    endedStreams: number;
    pausedStreams: number;
    withdrawnStreams: number;
    draftStreams: number;
    failedWithdrawals: number;
  };
}): void {
  // In production, this would use a structured logging library
  console.log(
    JSON.stringify({
      event: "metrics_access",
      correlation_id: data.correlationId,
      service_name: data.serviceName,
      key_id: data.keyId,
      timestamp: new Date().toISOString(),
      metrics: data.metrics,
    })
  );
}

/**
 * Logs metrics errors for debugging
 */
function logMetricsError(data: {
  correlationId: string;
  serviceName: string;
  keyId: string;
  error: string;
}): void {
  // In production, this would use a structured logging library
  console.error(
    JSON.stringify({
      event: "metrics_error",
      correlation_id: data.correlationId,
      service_name: data.serviceName,
      key_id: data.keyId,
      timestamp: new Date().toISOString(),
      error: data.error,
    })
  );
import { logger } from "@/app/lib/logger";
import { getMetrics } from "@/app/lib/rate-limit-metrics";

/**
 * GET /api/metrics
 *
 * Exposes application metrics in Prometheus text exposition format.
 *
 * ## Authentication
 * The endpoint is gated by a static bearer token supplied via the
 * `METRICS_AUTH_TOKEN` environment variable. Callers must present it as
 * `Authorization: Bearer <token>`. If the variable is unset the route is
 * disabled (returns 503) so metrics are never exposed accidentally.
 *
 * The token comparison is constant-time to avoid leaking its length or
 * contents through timing side-channels.
 *
 * ## Response
 * - `200 text/plain; version=0.0.4` — Prometheus metrics on success.
 * - `401` — missing or malformed `Authorization` header.
 * - `403` — token present but incorrect.
 * - `503` — endpoint disabled (no token configured).
 */

const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Constant-time string comparison. Returns `true` only when both inputs are
 * identical. The loop always runs over the longer of the two lengths so the
 * timing does not depend on where the first mismatch occurs.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Escapes a Prometheus label value per the text exposition format spec. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/**
 * Renders the in-memory counters as Prometheus metrics. Each metric carries a
 * `# HELP` and `# TYPE` line followed by one sample per label set.
 */
function renderPrometheus(): string {
  const metrics = getMetrics();
  const lines: string[] = [];

  lines.push("# HELP streampay_requests_total Total requests observed per route.");
  lines.push("# TYPE streampay_requests_total counter");
  for (const [route, count] of Object.entries(metrics.total)) {
    lines.push(`streampay_requests_total{route="${escapeLabel(route)}"} ${count}`);
  }

  lines.push("# HELP streampay_rate_limit_throttled_total Throttled requests per route and limit type.");
  lines.push("# TYPE streampay_rate_limit_throttled_total counter");
  for (const [key, count] of Object.entries(metrics.throttled)) {
    const sep = key.lastIndexOf(":");
    const route = sep >= 0 ? key.slice(0, sep) : key;
    const limitType = sep >= 0 ? key.slice(sep + 1) : "unknown";
    lines.push(
      `streampay_rate_limit_throttled_total{route="${escapeLabel(route)}",limit_type="${escapeLabel(limitType)}"} ${count}`
    );
  }

  // Always-present gauge so scrapers can confirm the endpoint is healthy even
  // when no traffic has been recorded yet.
  lines.push("# HELP streampay_metrics_up Whether the metrics endpoint is serving.");
  lines.push("# TYPE streampay_metrics_up gauge");
  lines.push("streampay_metrics_up 1");

  return `${lines.join("\n")}\n`;
}

export async function GET(request: Request): Promise<NextResponse> {
  const expected = process.env.METRICS_AUTH_TOKEN;

  if (!expected) {
    logger.warn("Metrics endpoint requested but METRICS_AUTH_TOKEN is not configured");
    return NextResponse.json(
      { error: { code: "METRICS_DISABLED", message: "Metrics endpoint is not configured." } },
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Missing or malformed Authorization header." } },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  if (!timingSafeEqual(match[1], expected)) {
    logger.warn("Metrics endpoint rejected an invalid token");
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Invalid metrics token." } },
      { status: 403 }
    );
  }

  const body = renderPrometheus();
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": PROM_CONTENT_TYPE, "Cache-Control": "no-store" },
  });
}
