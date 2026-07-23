import { GET } from "./route";
import { NextRequest } from "next/server";
import { createInternalServiceRequestHeaders } from "@/app/lib/internal-service-auth";
import { getStore } from "@/app/lib/db";

// Mock dependencies
jest.mock("@/app/lib/internal-service-auth");
jest.mock("@/app/lib/db");

describe("GET /api/metrics", () => {
  const mockConfig = {
    internalServiceAuth: {
      keys: {
        "test-key-id": "test-secret-key",
      },
      allowedClockSkewSeconds: 300,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...mockConfig };
  });

  describe("Authentication", () => {
    it("should reject requests without internal service authentication", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "INTERNAL_AUTH_REQUIRED", message: "Authentication required" } }), {
          status: 401,
        })
      );

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it("should reject requests from unauthorized services", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "SERVICE_NOT_ALLOWED", message: "Service not allowed" } }), {
          status: 403,
        })
      );

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(403);
    });

    it("should allow requests from authorized services", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const mockStreamRepository = {
        streams: new Map([
          [
            "stream-1",
            {
              id: "stream-1",
              status: "active",
              recipient: "GABC...",
              vestedAmount: "1000000000",
              releasedAmount: "0",
            },
          ],
        ]),
      };

      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe("Metrics Generation", () => {
    beforeEach(() => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });
    });

    it("should return Prometheus-formatted metrics", async () => {
      const mockStreamRepository = {
        streams: new Map([
          [
            "stream-1",
            {
              id: "stream-1",
              status: "active",
              recipient: "GABC...",
              vestedAmount: "1000000000",
              releasedAmount: "0",
            },
          ],
        ]),
      };

      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain; version=0.0.4");
      expect(response.headers.get("X-Correlation-ID")).toBeDefined();

      const text = await response.text();
      expect(text).toContain("# HELP");
      expect(text).toContain("# TYPE");
      expect(text).toContain("streampay_streams_total");
      expect(text).toContain("streampay_streams_active");
    });

    it("should calculate correct metrics from streams", async () => {
      const mockStreamRepository = {
        streams: new Map([
          [
            "stream-1",
            { id: "stream-1", status: "active", recipient: "GABC...", vestedAmount: "1000000000", releasedAmount: "0" },
          ],
          [
            "stream-2",
            { id: "stream-2", status: "ended", recipient: "GDEF...", vestedAmount: "2000000000", releasedAmount: "2000000000" },
          ],
          [
            "stream-3",
            { id: "stream-3", status: "paused", recipient: "GHIJ...", vestedAmount: "3000000000", releasedAmount: "1000000000" },
          ],
          [
            "stream-4",
            { id: "stream-4", status: "withdrawn", recipient: "GKLM...", vestedAmount: "4000000000", releasedAmount: "4000000000" },
          ],
          [
            "stream-5",
            { id: "stream-5", status: "draft", recipient: "GNOP...", vestedAmount: "5000000000", releasedAmount: "0" },
          ],
          [
            "stream-6",
            {
              id: "stream-6",
              status: "active",
              recipient: "GQRS...",
              vestedAmount: "6000000000",
              releasedAmount: "0",
              withdrawal: { state: "failed" },
            },
          ],
        ]),
      };

      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain("streampay_streams_total{correlation_id="); // Total: 6
      expect(text).toContain("streampay_streams_active{correlation_id="); // Active: 2
      expect(text).toContain("streampay_streams_ended{correlation_id="); // Ended: 1
      expect(text).toContain("streampay_streams_paused{correlation_id="); // Paused: 1
      expect(text).toContain("streampay_streams_withdrawn{correlation_id="); // Withdrawn: 1
      expect(text).toContain("streampay_streams_draft{correlation_id="); // Draft: 1
      expect(text).toContain("streampay_failed_withdrawals_total{correlation_id="); // Failed: 1
    });

    it("should handle empty stream repository", async () => {
      const mockStreamRepository = {
        streams: new Map(),
      };

      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain("streampay_streams_total{correlation_id="); // Total: 0
      expect(text).toContain("streampay_streams_active{correlation_id="); // Active: 0
    });
  });

  describe("Error Handling", () => {
    it("should handle database store errors gracefully", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      (getStore as jest.Mock).mockImplementation(() => {
        throw new Error("Database connection failed");
      });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(500);
      const json = await response.json();
      expect(json.error.code).toBe("METRICS_ERROR");
    });

    it("should log errors with correlation ID", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      (getStore as jest.Mock).mockImplementation(() => {
        throw new Error("Test error");
      });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      await GET(request);

      expect(consoleSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(loggedData.event).toBe("metrics_error");
      expect(loggedData.correlation_id).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe("Structured Logging", () => {
    it("should log metrics access with correlation ID", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const mockStreamRepository = {
        streams: new Map([
          [
            "stream-1",
            { id: "stream-1", status: "active", recipient: "GABC...", vestedAmount: "1000000000", releasedAmount: "0" },
          ],
        ]),
      };

      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const request = new NextRequest("http://localhost:3000/api/metrics");
      await GET(request);

      expect(consoleSpy).toHaveBeenCalled();
      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(loggedData.event).toBe("metrics_access");
      expect(loggedData.service_name).toBe("prometheus");
      expect(loggedData.key_id).toBe("test-key-id");
      expect(loggedData.correlation_id).toBeDefined();
      expect(loggedData.metrics).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe("Allowed Services", () => {
    it("should allow prometheus service", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "prometheus",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const mockStreamRepository = { streams: new Map() };
      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should allow monitoring service", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "monitoring",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const mockStreamRepository = { streams: new Map() };
      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should allow ops-automation service", async () => {
      const { requireInternalServiceAuth } = await import("@/app/lib/internal-service-auth");
      (requireInternalServiceAuth as jest.Mock).mockResolvedValue({
        serviceName: "ops-automation",
        keyId: "test-key-id",
        timestamp: new Date().toISOString(),
      });

      const mockStreamRepository = { streams: new Map() };
      (getStore as jest.Mock).mockReturnValue({ streamRepository: mockStreamRepository });

      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
/**
 * Tests for GET /api/metrics — token-gated Prometheus metrics endpoint.
 */

import { GET } from "./route";
import { recordRequest, recordThrottle, resetMetrics } from "@/app/lib/rate-limit-metrics";

const TOKEN = "test-metrics-token-123";

function makeRequest(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return new Request("http://localhost/api/metrics", { method: "GET", headers });
}

describe("GET /api/metrics", () => {
  const originalToken = process.env.METRICS_AUTH_TOKEN;

  beforeEach(() => {
    resetMetrics();
    process.env.METRICS_AUTH_TOKEN = TOKEN;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.METRICS_AUTH_TOKEN;
    else process.env.METRICS_AUTH_TOKEN = originalToken;
  });

  it("returns 503 when no token is configured", async () => {
    delete process.env.METRICS_AUTH_TOKEN;
    const res = await GET(makeRequest(`Bearer ${TOKEN}`));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("METRICS_DISABLED");
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 when the Authorization header is malformed", async () => {
    const res = await GET(makeRequest("Token abc"));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the token is incorrect", async () => {
    const res = await GET(makeRequest("Bearer wrong-token"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns Prometheus metrics for a valid token", async () => {
    recordRequest("/api/streams");
    recordRequest("/api/streams");
    recordThrottle("/api/streams", "perMinute", "wallet", "GABC");

    const res = await GET(makeRequest(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");

    const text = await res.text();
    expect(text).toContain("# TYPE streampay_requests_total counter");
    expect(text).toContain('streampay_requests_total{route="/api/streams"} 2');
    expect(text).toContain(
      'streampay_rate_limit_throttled_total{route="/api/streams",limit_type="perMinute"} 1'
    );
    expect(text).toContain("streampay_metrics_up 1");
  });

  it("accepts a case-insensitive bearer scheme", async () => {
    const res = await GET(makeRequest(`bearer ${TOKEN}`));
    expect(res.status).toBe(200);
  });
});
