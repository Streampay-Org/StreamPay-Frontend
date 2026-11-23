import {
  DEFAULT_WEBHOOK_HEALTH_CONFIG,
  WebhookHealthDetector,
  webhookHealthDetector,
  validateObservationInput,
  validateWebhookHealthConfig,
} from "./webhookHealth";

describe("WebhookHealthDetector", () => {
  let detector: WebhookHealthDetector;

  beforeEach(() => {
    detector = new WebhookHealthDetector();
    webhookHealthDetector.clear();
  });

  describe("Configuration & Boundary Validation", () => {
    it("uses default configuration when initialized without arguments", () => {
      const config = detector.getConfig();
      expect(config).toEqual(DEFAULT_WEBHOOK_HEALTH_CONFIG);
      expect(config.authFailureThreshold).toBe(0.15);
      expect(config.unauthorizedThreshold).toBe(0.1);
      expect(config.forbiddenThreshold).toBe(0.1);
      expect(config.windowMs).toBe(300_000);
      expect(config.minObservations).toBe(5);
      expect(config.consecutiveAuthFailureLimit).toBe(3);
    });

    it("allows custom configuration during initialization", () => {
      const custom = new WebhookHealthDetector({
        authFailureThreshold: 0.25,
        windowMs: 60_000,
        minObservations: 10,
      });
      const config = custom.getConfig();
      expect(config.authFailureThreshold).toBe(0.25);
      expect(config.windowMs).toBe(60_000);
      expect(config.minObservations).toBe(10);
    });

    it("updates configuration dynamically with updateConfig()", () => {
      detector.updateConfig({ authFailureThreshold: 0.2 });
      expect(detector.getConfig().authFailureThreshold).toBe(0.2);
    });

    it("validates config options via validateWebhookHealthConfig()", () => {
      expect(
        validateWebhookHealthConfig({ authFailureThreshold: 1.5 }),
      ).toEqual({
        error: {
          code: "INVALID_CONFIG",
          message: "authFailureThreshold must be a number between 0.0 and 1.0.",
          field: "authFailureThreshold",
        },
      });

      expect(validateWebhookHealthConfig({ windowMs: -100 })).toEqual({
        error: {
          code: "INVALID_CONFIG",
          message: "windowMs must be a positive number greater than zero.",
          field: "windowMs",
        },
      });

      expect(validateWebhookHealthConfig({ minObservations: 0 })).toEqual({
        error: {
          code: "INVALID_CONFIG",
          message: "minObservations must be an integer greater than or equal to 1.",
          field: "minObservations",
        },
      });

      expect(
        validateWebhookHealthConfig({ consecutiveAuthFailureLimit: 0 }),
      ).toEqual({
        error: {
          code: "INVALID_CONFIG",
          message:
            "consecutiveAuthFailureLimit must be an integer greater than or equal to 1.",
          field: "consecutiveAuthFailureLimit",
        },
      });
    });

    it("throws error when initializing or updating with invalid config", () => {
      expect(
        () => new WebhookHealthDetector({ authFailureThreshold: -0.5 }),
      ).toThrow("[WebhookHealthDetector]");

      expect(() =>
        detector.updateConfig({ unauthorizedThreshold: 2.0 }),
      ).toThrow("[WebhookHealthDetector]");
    });

    it("validates observation parameters via validateObservationInput()", () => {
      expect(validateObservationInput("", 200)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "endpointId must be a non-empty string.",
          field: "endpointId",
        },
      });

      expect(validateObservationInput("ep-1", 99)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message:
            "statusCode must be a valid HTTP status integer between 100 and 599.",
          field: "statusCode",
        },
      });

      expect(validateObservationInput("ep-1", 600)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message:
            "statusCode must be a valid HTTP status integer between 100 and 599.",
          field: "statusCode",
        },
      });

      expect(validateObservationInput("ep-1", 200, -500)).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "timestamp must be a valid positive epoch millisecond number.",
          field: "timestamp",
        },
      });
    });

    it("throws when recordAttempt is called with invalid parameters", () => {
      expect(() => detector.recordAttempt("", 200)).toThrow(
        "[WebhookHealthDetector]",
      );
      expect(() => detector.recordAttempt("ep-1", 700)).toThrow(
        "[WebhookHealthDetector]",
      );
      expect(() => detector.recordAttempt("ep-1", 200, NaN)).toThrow(
        "[WebhookHealthDetector]",
      );
    });
  });

  describe("Healthy Operation", () => {
    it("returns null alert for successful delivery attempts (200 OK)", () => {
      const alert = detector.recordAttempt("ep-healthy", 200);
      expect(alert).toBeNull();
    });

    it("reports healthy endpoint status for clean deliveries", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        detector.recordAttempt("ep-healthy", 200, now + i * 1000);
      }

      const status = detector.checkEndpointHealth("ep-healthy", now + 5000);
      expect(status.status).toBe("healthy");
      expect(status.anomalyDetected).toBe(false);
      expect(status.totalAttempts).toBe(5);
      expect(status.successCount).toBe(5);
      expect(status.unauthorizedCount).toBe(0);
      expect(status.forbiddenCount).toBe(0);
      expect(status.authFailureRate).toBe(0);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.activeAlerts).toHaveLength(0);
    });
  });

  describe("401 / 403 Threshold & Anomaly Detection", () => {
    it("detects 401 Unauthorized rate spike when exceeding threshold", () => {
      const now = Date.now();
      // Record 3 x 200 OK and 2 x 401 Unauthorized (401 rate = 2/5 = 40% > 10% threshold)
      detector.recordAttempt("ep-401", 200, now);
      detector.recordAttempt("ep-401", 200, now + 10);
      detector.recordAttempt("ep-401", 200, now + 20);
      detector.recordAttempt("ep-401", 401, now + 30);
      const alert = detector.recordAttempt("ep-401", 401, now + 40);

      expect(alert).not.toBeNull();
      expect(alert?.anomalyDetected).toBe(true);
      expect(alert?.unauthorizedCount).toBe(2);
      expect(alert?.totalAttempts).toBe(5);
      expect(alert?.unauthorizedRate).toBe(0.4);
      expect(alert?.message).toContain("401 Unauthorized rate (40.0%)");

      const health = detector.checkEndpointHealth("ep-401", now + 50);
      expect(health.status).toBe("degraded");
      expect(health.anomalyDetected).toBe(true);
    });

    it("detects 403 Forbidden rate spike when exceeding threshold", () => {
      const now = Date.now();
      // Record 3 x 200 OK and 2 x 403 Forbidden (403 rate = 2/5 = 40% > 10% threshold)
      detector.recordAttempt("ep-403", 200, now);
      detector.recordAttempt("ep-403", 200, now + 10);
      detector.recordAttempt("ep-403", 200, now + 20);
      detector.recordAttempt("ep-403", 403, now + 30);
      const alert = detector.recordAttempt("ep-403", 403, now + 40);

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe("HIGH_403_RATE");
      expect(alert?.forbiddenCount).toBe(2);
      expect(alert?.forbiddenRate).toBe(0.4);
    });

    it("respects minObservations before raising percentage-based rate alerts", () => {
      const now = Date.now();
      // 1 attempt out of 1 is 100% 401, but total attempts < minObservations (5)
      const alert1 = detector.recordAttempt("ep-low-volume", 401, now);
      expect(alert1).toBeNull();

      const health1 = detector.checkEndpointHealth("ep-low-volume", now);
      expect(health1.anomalyDetected).toBe(false);
    });

    it("triggers consecutive failure alert when auth failures reach consecutiveAuthFailureLimit", () => {
      const now = Date.now();
      // 3 consecutive auth failures (limit = 3)
      detector.recordAttempt("ep-consec", 401, now);
      detector.recordAttempt("ep-consec", 403, now + 10);
      const alert = detector.recordAttempt("ep-consec", 401, now + 20);

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe("CONSECUTIVE_AUTH_FAILURES");
      expect(alert?.consecutiveFailures).toBe(3);

      const health = detector.checkEndpointHealth("ep-consec", now + 30);
      expect(health.status).toBe("critical");
    });

    it("resets consecutive failure counter on successful response (200 OK)", () => {
      const now = Date.now();
      detector.recordAttempt("ep-reset", 401, now);
      detector.recordAttempt("ep-reset", 401, now + 10);
      // Success resets counter
      detector.recordAttempt("ep-reset", 200, now + 20);
      // Subsequent 401 starts new count from 1
      const alert = detector.recordAttempt("ep-reset", 401, now + 30);
      expect(alert).toBeNull();

      const health = detector.checkEndpointHealth("ep-reset", now + 40);
      expect(health.consecutiveFailures).toBe(1);
    });
  });

  describe("Sliding Time Window Pruning", () => {
    it("prunes observations older than windowMs", () => {
      const baseTime = 1_000_000;
      const windowMs = 300_000; // 5 minutes

      // Record 5 x 401 responses in the past
      for (let i = 0; i < 5; i++) {
        detector.recordAttempt("ep-prune", 401, baseTime + i * 1000);
      }

      // Fast forward time past the window (baseTime + windowMs + 10,000)
      const futureTime = baseTime + windowMs + 10_000;
      detector.recordAttempt("ep-prune", 200, futureTime);

      const health = detector.checkEndpointHealth("ep-prune", futureTime);
      expect(health.totalAttempts).toBe(1);
      expect(health.unauthorizedCount).toBe(0);
      expect(health.successCount).toBe(1);
      expect(health.status).toBe("healthy");
    });
  });

  describe("Multi-Endpoint Management & Clearing", () => {
    it("tracks multiple endpoints independently", () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        detector.recordAttempt("ep-a", 200, now + i);
        detector.recordAttempt("ep-b", 401, now + i);
      }

      const allHealth = detector.getAllEndpointsHealth(now + 100);
      expect(allHealth["ep-a"].status).toBe("healthy");
      expect(allHealth["ep-b"].anomalyDetected).toBe(true);
    });

    it("clears specific endpoint observations with clear(endpointId)", () => {
      detector.recordAttempt("ep-clear-1", 401, Date.now());
      detector.recordAttempt("ep-clear-2", 401, Date.now());

      detector.clear("ep-clear-1");
      const health1 = detector.checkEndpointHealth("ep-clear-1");
      expect(health1.totalAttempts).toBe(0);

      const health2 = detector.checkEndpointHealth("ep-clear-2");
      expect(health2.totalAttempts).toBe(1);
    });

    it("clears all endpoint observations with clear()", () => {
      detector.recordAttempt("ep-clear-1", 401, Date.now());
      detector.recordAttempt("ep-clear-2", 401, Date.now());

      detector.clear();
      const all = detector.getAllEndpointsHealth();
      expect(Object.keys(all)).toHaveLength(0);
    });
  });

  describe("Global Singleton Export", () => {
    it("provides clean global webhookHealthDetector instance", () => {
      expect(webhookHealthDetector).toBeInstanceOf(WebhookHealthDetector);
      webhookHealthDetector.recordAttempt("global-ep", 200);
      const health = webhookHealthDetector.checkEndpointHealth("global-ep");
      expect(health.totalAttempts).toBe(1);
    });
  });
});
