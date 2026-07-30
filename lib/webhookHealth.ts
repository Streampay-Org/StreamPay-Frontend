import { getCorrelationContext, logger } from "@/app/lib/logger";

/**
 * Webhook Health Anomaly Detector
 *
 * ## Purpose
 * Detects security and configuration anomalies in webhook delivery, specifically
 * tracking 401 (Unauthorized) and 403 (Forbidden) response rates against defined
 * rate thresholds within a sliding time window.
 *
 * High rates of 401 or 403 responses indicate expired webhook secrets, invalid signature
 * configurations, or revoked subscriber permissions.
 *
 * ## Features
 * - Boundary input validation for all arguments (endpoint IDs, HTTP status codes, timestamps, thresholds).
 * - Sliding time-window observation storage per webhook endpoint.
 * - 401 / 403 threshold evaluation and rate calculation.
 * - Consecutive authentication failure threshold detection.
 * - Structured JSON logging with correlation IDs via `@/app/lib/logger`.
 * - Standardized error envelope for boundary validation failures.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Configuration options for the webhook health detector. */
export interface WebhookHealthConfig {
  /**
   * Maximum acceptable combined ratio of 401/403 responses (0.0 to 1.0).
   * Default: 0.15 (15%).
   */
  authFailureThreshold: number;

  /**
   * Maximum acceptable ratio of 401 Unauthorized responses specifically (0.0 to 1.0).
   * Default: 0.10 (10%).
   */
  unauthorizedThreshold: number;

  /**
   * Maximum acceptable ratio of 403 Forbidden responses specifically (0.0 to 1.0).
   * Default: 0.10 (10%).
   */
  forbiddenThreshold: number;

  /**
   * Sliding time window duration in milliseconds.
   * Default: 300,000 ms (5 minutes).
   */
  windowMs: number;

  /**
   * Minimum total observations within window required before evaluating percentage threshold alerts.
   * Default: 5.
   */
  minObservations: number;

  /**
   * Maximum allowable consecutive 401/403 failures before triggering an immediate alert.
   * Default: 3.
   */
  consecutiveAuthFailureLimit: number;
}

/** Default configuration values. */
export const DEFAULT_WEBHOOK_HEALTH_CONFIG: WebhookHealthConfig = {
  authFailureThreshold: 0.15,
  unauthorizedThreshold: 0.10,
  forbiddenThreshold: 0.10,
  windowMs: 300_000, // 5 minutes
  minObservations: 5,
  consecutiveAuthFailureLimit: 3,
};

/** Single recorded delivery attempt observation. */
export interface WebhookAttemptObservation {
  endpointId: string;
  statusCode: number;
  timestamp: number;
  deliveryId?: string;
}

/** Anomaly detection alert payload. */
export interface WebhookAnomalyAlert {
  type: "HIGH_AUTH_FAILURE_RATE" | "HIGH_401_RATE" | "HIGH_403_RATE" | "CONSECUTIVE_AUTH_FAILURES";
  endpointId: string;
  anomalyDetected: boolean;
  unauthorizedCount: number;
  forbiddenCount: number;
  totalAttempts: number;
  authFailureRate: number;
  unauthorizedRate: number;
  forbiddenRate: number;
  consecutiveFailures: number;
  threshold: number;
  message: string;
  timestamp: string;
  correlationId?: string;
}

/** Detailed health status for an endpoint. */
export interface EndpointHealthStatus {
  endpointId: string;
  status: "healthy" | "degraded" | "critical";
  anomalyDetected: boolean;
  totalAttempts: number;
  successCount: number;
  unauthorizedCount: number;
  forbiddenCount: number;
  otherFailureCount: number;
  authFailureRate: number;
  consecutiveFailures: number;
  activeAlerts: WebhookAnomalyAlert[];
  checkedAt: string;
}

/** Standardized error envelope for boundary validation failures. */
export interface WebhookHealthValidationError {
  error: {
    code: "INVALID_INPUT" | "INVALID_CONFIG";
    message: string;
    field?: string;
  };
}

// ── Validation Helpers ──────────────────────────────────────────────────────

/**
 * Validates a configuration object at the boundary.
 */
export function validateWebhookHealthConfig(
  config: Partial<WebhookHealthConfig>,
): WebhookHealthValidationError | null {
  if (
    config.authFailureThreshold !== undefined &&
    (typeof config.authFailureThreshold !== "number" ||
      Number.isNaN(config.authFailureThreshold) ||
      config.authFailureThreshold < 0 ||
      config.authFailureThreshold > 1)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "authFailureThreshold must be a number between 0.0 and 1.0.",
        field: "authFailureThreshold",
      },
    };
  }

  if (
    config.unauthorizedThreshold !== undefined &&
    (typeof config.unauthorizedThreshold !== "number" ||
      Number.isNaN(config.unauthorizedThreshold) ||
      config.unauthorizedThreshold < 0 ||
      config.unauthorizedThreshold > 1)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "unauthorizedThreshold must be a number between 0.0 and 1.0.",
        field: "unauthorizedThreshold",
      },
    };
  }

  if (
    config.forbiddenThreshold !== undefined &&
    (typeof config.forbiddenThreshold !== "number" ||
      Number.isNaN(config.forbiddenThreshold) ||
      config.forbiddenThreshold < 0 ||
      config.forbiddenThreshold > 1)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "forbiddenThreshold must be a number between 0.0 and 1.0.",
        field: "forbiddenThreshold",
      },
    };
  }

  if (
    config.windowMs !== undefined &&
    (typeof config.windowMs !== "number" ||
      !Number.isFinite(config.windowMs) ||
      config.windowMs <= 0)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "windowMs must be a positive number greater than zero.",
        field: "windowMs",
      },
    };
  }

  if (
    config.minObservations !== undefined &&
    (typeof config.minObservations !== "number" ||
      !Number.isInteger(config.minObservations) ||
      config.minObservations < 1)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "minObservations must be an integer greater than or equal to 1.",
        field: "minObservations",
      },
    };
  }

  if (
    config.consecutiveAuthFailureLimit !== undefined &&
    (typeof config.consecutiveAuthFailureLimit !== "number" ||
      !Number.isInteger(config.consecutiveAuthFailureLimit) ||
      config.consecutiveAuthFailureLimit < 1)
  ) {
    return {
      error: {
        code: "INVALID_CONFIG",
        message: "consecutiveAuthFailureLimit must be an integer greater than or equal to 1.",
        field: "consecutiveAuthFailureLimit",
      },
    };
  }

  return null;
}

/**
 * Validates observation input parameters at the boundary.
 */
export function validateObservationInput(
  endpointId: unknown,
  statusCode: unknown,
  timestamp?: unknown,
): WebhookHealthValidationError | null {
  if (!endpointId || typeof endpointId !== "string" || endpointId.trim().length === 0) {
    return {
      error: {
        code: "INVALID_INPUT",
        message: "endpointId must be a non-empty string.",
        field: "endpointId",
      },
    };
  }

  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 100 ||
    statusCode > 599
  ) {
    return {
      error: {
        code: "INVALID_INPUT",
        message: "statusCode must be a valid HTTP status integer between 100 and 599.",
        field: "statusCode",
      },
    };
  }

  if (
    timestamp !== undefined &&
    (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0)
  ) {
    return {
      error: {
        code: "INVALID_INPUT",
        message: "timestamp must be a valid positive epoch millisecond number.",
        field: "timestamp",
      },
    };
  }

  return null;
}

// ── WebhookHealthDetector Class ─────────────────────────────────────────────

export class WebhookHealthDetector {
  private config: WebhookHealthConfig;
  private observationsMap: Map<string, WebhookAttemptObservation[]> = new Map();
  private consecutiveFailuresMap: Map<string, number> = new Map();

  constructor(config: Partial<WebhookHealthConfig> = {}) {
    const err = validateWebhookHealthConfig(config);
    if (err) {
      throw new Error(`[WebhookHealthDetector] ${err.error.message}`);
    }
    this.config = { ...DEFAULT_WEBHOOK_HEALTH_CONFIG, ...config };
  }

  /**
   * Retrieves the current configuration settings.
   */
  public getConfig(): WebhookHealthConfig {
    return { ...this.config };
  }

  /**
   * Updates configuration settings at runtime with boundary validation.
   */
  public updateConfig(newConfig: Partial<WebhookHealthConfig>): void {
    const err = validateWebhookHealthConfig(newConfig);
    if (err) {
      throw new Error(`[WebhookHealthDetector] ${err.error.message}`);
    }
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Records a webhook delivery attempt and checks for rate thresholds / anomalies.
   *
   * @param endpointId Unique identifier or URL of the target webhook endpoint.
   * @param statusCode HTTP response status code (e.g. 200, 401, 403, 500).
   * @param timestamp Epoch milliseconds when attempt occurred (defaults to Date.now()).
   * @param deliveryId Optional delivery attempt correlation ID.
   * @returns Primary WebhookAnomalyAlert if an anomaly threshold is breached, otherwise null.
   */
  public recordAttempt(
    endpointId: string,
    statusCode: number,
    timestamp: number = Date.now(),
    deliveryId?: string,
  ): WebhookAnomalyAlert | null {
    const validationErr = validateObservationInput(endpointId, statusCode, timestamp);
    if (validationErr) {
      throw new Error(`[WebhookHealthDetector] ${validationErr.error.message}`);
    }

    const cleanEndpointId = endpointId.trim();
    const isAuthFailure = statusCode === 401 || statusCode === 403;

    // Track consecutive authentication failures
    const currentConsecutive = this.consecutiveFailuresMap.get(cleanEndpointId) ?? 0;
    const newConsecutive = isAuthFailure ? currentConsecutive + 1 : 0;
    this.consecutiveFailuresMap.set(cleanEndpointId, newConsecutive);

    // Prune stale observations and append new observation
    const windowStart = timestamp - this.config.windowMs;
    const existingObs = this.observationsMap.get(cleanEndpointId) ?? [];
    const validObs = existingObs.filter((obs) => obs.timestamp >= windowStart);

    validObs.push({
      endpointId: cleanEndpointId,
      statusCode,
      timestamp,
      deliveryId,
    });

    this.observationsMap.set(cleanEndpointId, validObs);

    // Evaluate anomaly alerts
    const alerts = this.evaluateEndpointAlerts(cleanEndpointId, validObs, newConsecutive);
    if (alerts.length > 0) {
      const primaryAlert = alerts[0];
      const context = getCorrelationContext();
      logger.warn(`[WebhookHealth] ${primaryAlert.message}`, {
        endpoint_id: cleanEndpointId,
        anomaly_type: primaryAlert.type,
        status_code: statusCode,
        unauthorized_count: primaryAlert.unauthorizedCount,
        forbidden_count: primaryAlert.forbiddenCount,
        total_attempts: primaryAlert.totalAttempts,
        auth_failure_rate: primaryAlert.authFailureRate,
        consecutive_failures: primaryAlert.consecutiveFailures,
        correlation_id: context?.correlation_id,
        request_id: context?.request_id,
      });
      return primaryAlert;
    }

    return null;
  }

  /**
   * Evaluates anomaly alerts for an endpoint given its active window observations.
   */
  private evaluateEndpointAlerts(
    endpointId: string,
    observations: WebhookAttemptObservation[],
    consecutiveFailures: number,
  ): WebhookAnomalyAlert[] {
    const alerts: WebhookAnomalyAlert[] = [];
    const totalAttempts = observations.length;
    const unauthorizedCount = observations.filter((o) => o.statusCode === 401).length;
    const forbiddenCount = observations.filter((o) => o.statusCode === 403).length;
    const authFailureCount = unauthorizedCount + forbiddenCount;

    const authFailureRate = totalAttempts > 0 ? authFailureCount / totalAttempts : 0;
    const unauthorizedRate = totalAttempts > 0 ? unauthorizedCount / totalAttempts : 0;
    const forbiddenRate = totalAttempts > 0 ? forbiddenCount / totalAttempts : 0;

    const context = getCorrelationContext();
    const isoNow = new Date().toISOString();

    // Check 1: Consecutive authentication failure limit
    if (consecutiveFailures >= this.config.consecutiveAuthFailureLimit) {
      alerts.push({
        type: "CONSECUTIVE_AUTH_FAILURES",
        endpointId,
        anomalyDetected: true,
        unauthorizedCount,
        forbiddenCount,
        totalAttempts,
        authFailureRate,
        unauthorizedRate,
        forbiddenRate,
        consecutiveFailures,
        threshold: this.config.consecutiveAuthFailureLimit,
        message: `Endpoint '${endpointId}' reached ${consecutiveFailures} consecutive 401/403 auth failures (limit: ${this.config.consecutiveAuthFailureLimit}).`,
        timestamp: isoNow,
        correlationId: context?.correlation_id,
      });
    }

    // Percentage rate evaluations require minObservations
    if (totalAttempts >= this.config.minObservations) {
      // Check 2: 401 Unauthorized specific threshold
      if (unauthorizedRate >= this.config.unauthorizedThreshold) {
        alerts.push({
          type: "HIGH_401_RATE",
          endpointId,
          anomalyDetected: true,
          unauthorizedCount,
          forbiddenCount,
          totalAttempts,
          authFailureRate,
          unauthorizedRate,
          forbiddenRate,
          consecutiveFailures,
          threshold: this.config.unauthorizedThreshold,
          message: `Endpoint '${endpointId}' 401 Unauthorized rate (${(unauthorizedRate * 100).toFixed(1)}%) exceeded threshold (${(this.config.unauthorizedThreshold * 100).toFixed(1)}%).`,
          timestamp: isoNow,
          correlationId: context?.correlation_id,
        });
      }

      // Check 3: 403 Forbidden specific threshold
      if (forbiddenRate >= this.config.forbiddenThreshold) {
        alerts.push({
          type: "HIGH_403_RATE",
          endpointId,
          anomalyDetected: true,
          unauthorizedCount,
          forbiddenCount,
          totalAttempts,
          authFailureRate,
          unauthorizedRate,
          forbiddenRate,
          consecutiveFailures,
          threshold: this.config.forbiddenThreshold,
          message: `Endpoint '${endpointId}' 403 Forbidden rate (${(forbiddenRate * 100).toFixed(1)}%) exceeded threshold (${(this.config.forbiddenThreshold * 100).toFixed(1)}%).`,
          timestamp: isoNow,
          correlationId: context?.correlation_id,
        });
      }

      // Check 4: Combined 401/403 failure rate threshold
      if (authFailureRate >= this.config.authFailureThreshold) {
        alerts.push({
          type: "HIGH_AUTH_FAILURE_RATE",
          endpointId,
          anomalyDetected: true,
          unauthorizedCount,
          forbiddenCount,
          totalAttempts,
          authFailureRate,
          unauthorizedRate,
          forbiddenRate,
          consecutiveFailures,
          threshold: this.config.authFailureThreshold,
          message: `Endpoint '${endpointId}' auth failure rate (${(authFailureRate * 100).toFixed(1)}%) exceeded threshold (${(this.config.authFailureThreshold * 100).toFixed(1)}%).`,
          timestamp: isoNow,
          correlationId: context?.correlation_id,
        });
      }
    }

    return alerts;
  }

  /**
   * Retrieves comprehensive health status and active anomalies for an endpoint.
   */
  public checkEndpointHealth(
    endpointId: string,
    now: number = Date.now(),
  ): EndpointHealthStatus {
    if (!endpointId || typeof endpointId !== "string" || endpointId.trim().length === 0) {
      throw new Error("[WebhookHealthDetector] endpointId must be a non-empty string.");
    }

    const cleanEndpointId = endpointId.trim();
    const windowStart = now - this.config.windowMs;
    const rawObs = this.observationsMap.get(cleanEndpointId) ?? [];
    const activeObs = rawObs.filter((o) => o.timestamp >= windowStart);

    const consecutiveFailures = this.consecutiveFailuresMap.get(cleanEndpointId) ?? 0;
    const activeAlerts = this.evaluateEndpointAlerts(
      cleanEndpointId,
      activeObs,
      consecutiveFailures,
    );

    const totalAttempts = activeObs.length;
    const successCount = activeObs.filter((o) => o.statusCode >= 200 && o.statusCode < 300).length;
    const unauthorizedCount = activeObs.filter((o) => o.statusCode === 401).length;
    const forbiddenCount = activeObs.filter((o) => o.statusCode === 403).length;
    const otherFailureCount = totalAttempts - successCount - unauthorizedCount - forbiddenCount;
    const authFailureRate = totalAttempts > 0 ? (unauthorizedCount + forbiddenCount) / totalAttempts : 0;

    let status: EndpointHealthStatus["status"] = "healthy";
    if (activeAlerts.some((a) => a.type === "CONSECUTIVE_AUTH_FAILURES")) {
      status = "critical";
    } else if (activeAlerts.length > 0) {
      status = "degraded";
    }

    return {
      endpointId: cleanEndpointId,
      status,
      anomalyDetected: activeAlerts.length > 0,
      totalAttempts,
      successCount,
      unauthorizedCount,
      forbiddenCount,
      otherFailureCount,
      authFailureRate,
      consecutiveFailures,
      activeAlerts,
      checkedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Returns aggregated health status across all tracked endpoints.
   */
  public getAllEndpointsHealth(
    now: number = Date.now(),
  ): Record<string, EndpointHealthStatus> {
    const result: Record<string, EndpointHealthStatus> = {};
    for (const endpointId of this.observationsMap.keys()) {
      result[endpointId] = this.checkEndpointHealth(endpointId, now);
    }
    return result;
  }

  /**
   * Resets observations and tracked states for a specific endpoint or all endpoints.
   */
  public clear(endpointId?: string): void {
    if (endpointId) {
      const clean = endpointId.trim();
      this.observationsMap.delete(clean);
      this.consecutiveFailuresMap.delete(clean);
    } else {
      this.observationsMap.clear();
      this.consecutiveFailuresMap.clear();
    }
  }
}

/** Singleton instance exported for global use across the application. */
export const webhookHealthDetector = new WebhookHealthDetector();
