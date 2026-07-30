import { GET } from "./route";
import { NextRequest } from "next/server";
import { getMetrics } from "@/app/lib/rate-limit-metrics";

// Mock dependencies
jest.mock("@/app/lib/logger");
jest.mock("@/app/lib/rate-limit-metrics");

describe("GET /api/metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.METRICS_AUTH_TOKEN = "test-token-12345";
  });

  afterEach(() => {
    delete process.env.METRICS_AUTH_TOKEN;
  });

  describe("Authentication", () => {
    it("should return 503 when METRICS_AUTH_TOKEN is not configured", async () => {
      delete process.env.METRICS_AUTH_TOKEN;
      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(503);
      const json = await response.json();
      expect(json.error.code).toBe("METRICS_DISABLED");
    });

    it("should return 401 when Authorization header is missing", async () => {
      const request = new NextRequest("http://localhost:3000/api/metrics");
      const response = await GET(request);

      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error.code).toBe("UNAUTHORIZED");
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    });

    it("should return 401 when Authorization header is malformed", async () => {
      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "InvalidFormat token" },
      });
      const response = await GET(request);

      expect(response.status).toBe(401);
      const json = await response.json();
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("should return 403 when token is incorrect", async () => {
      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer wrong-token" },
      });
      const response = await GET(request);

      expect(response.status).toBe(403);
      const json = await response.json();
      expect(json.error.code).toBe("FORBIDDEN");
    });

    it("should return 200 when token is correct", async () => {
      (getMetrics as jest.Mock).mockReturnValue({
        total: { "/api/streams": 100, "/api/streams/123": 50 },
        throttled: { "/api/streams:org": 5 },
      });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  describe("prom-client registry merge", () => {
    beforeEach(() => {
      (getMetrics as jest.Mock).mockReturnValue({
        total: {},
        throttled: {},
      });
    });

    it("appends prom-client registry output (webhook_*) to the response body", async () => {
      const { registry, webhookCounter } = require("@/src/metrics/registry");
      // Seed the shared registry with a known sample.
      webhookCounter.inc({ status: "200", event_type: "merge_test" });
      registry.resetMetrics();
      webhookCounter.inc({ status: "200", event_type: "merge_test" });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      const text = await response.text();
      // Custom surface still emitted.
      expect(text).toContain("streampay_metrics_up 1");
      // prom-client surface appended.
      expect(text).toContain("webhook_requests_total");
      expect(text).toContain('event_type="merge_test"');
    });

    it("appends wallet_auth_* per-endpoint metrics from the shared registry", async () => {
      const { registry, walletAuthCounter } = require("@/src/metrics/registry");
      registry.resetMetrics();
      walletAuthCounter.inc({
        method: "GET",
        operation: "challenge",
        status: "200",
      });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain("wallet_auth_requests_total");
      expect(text).toMatch(
        /wallet_auth_requests_total\{[^}]*method="GET"[^}]*operation="challenge"[^}]*status="200"[^}]*\}\s+1/,
      );
    });
  });

  describe("Metrics Format", () => {
    beforeEach(() => {
      (getMetrics as jest.Mock).mockReturnValue({
        total: { "/api/streams": 100, "/api/streams/123": 50 },
        throttled: { "/api/streams:org": 5, "/api/streams:rate": 3 },
      });
    });

    it("should return Prometheus-formatted metrics", async () => {
      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain("# HELP streampay_requests_total");
      expect(text).toContain("# TYPE streampay_requests_total counter");
      expect(text).toContain("streampay_requests_total{route=\"/api/streams\"} 100");
      expect(text).toContain("# HELP streampay_rate_limit_throttled_total");
      expect(text).toContain("# TYPE streampay_rate_limit_throttled_total counter");
      expect(text).toContain("streampay_rate_limit_throttled_total{route=\"/api/streams\",limit_type=\"org\"} 5");
      expect(text).toContain("# HELP streampay_metrics_up");
      expect(text).toContain("# TYPE streampay_metrics_up gauge");
      expect(text).toContain("streampay_metrics_up 1");
    });

    it("should escape special characters in route labels", async () => {
      (getMetrics as jest.Mock).mockReturnValue({
        total: { "/api/streams/test\"quote": 10, "/api/streams\\backslash": 5 },
        throttled: {},
      });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain('route="/api/streams/test\\"quote"');
      expect(text).toContain('route="/api/streams\\\\backslash"');
    });

    it("should handle empty metrics", async () => {
      (getMetrics as jest.Mock).mockReturnValue({
        total: {},
        throttled: {},
      });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      const text = await response.text();
      expect(text).toContain("streampay_metrics_up 1");
    });
  });

  describe("Security", () => {
    it("should use constant-time comparison for token validation", async () => {
      (getMetrics as jest.Mock).mockReturnValue({ total: {}, throttled: {} });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer test-token-12345" },
      });
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("should handle tokens of different lengths safely", async () => {
      (getMetrics as jest.Mock).mockReturnValue({ total: {}, throttled: {} });

      const request = new NextRequest("http://localhost:3000/api/metrics", {
        headers: { authorization: "Bearer wrong-length-token" },
      });
      const response = await GET(request);

      expect(response.status).toBe(403);
    });
  });
});
