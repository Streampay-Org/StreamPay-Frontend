/**
 * Tests for GET /api/webhooks/health
 */

import { GET } from "./route";
import { deriveHealthStatus } from "./health";
import type { WebhookSubscriptionStats, WebhookDeliveryStats } from "./health";

jest.mock("next/server", () => ({
  NextResponse: {
    json: <T>(body: T, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
      json: async () => body,
    }),
  },
}));

jest.mock("next/headers", () => ({
  headers: () => ({ get: () => null }),
}));

// Mock request for withTimeout — must provide method, url, and headers.
const mockRequest = {
  method: "GET",
  url: "http://localhost/api/webhooks/health",
  headers: new Headers(),
} as unknown as Request;

const emptyStats: WebhookDeliveryStats = {
  total: 0,
  delivered: 0,
  failed: 0,
  pending: 0,
  dlq: 0,
  success_rate_pct: 100,
};

describe("GET /api/webhooks/health", () => {
  it("returns 200 with expected shape", async () => {
    const res = await GET(mockRequest);
    expect(res.status).toBe(200);

    const body = (res as unknown as { body: Record<string, unknown> }).body;
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("checked_at");
    expect(body).toHaveProperty("subscriptions");
    expect(body).toHaveProperty("delivery_stats");
  });

  it("returns status 'ok' when all subscriptions are healthy", async () => {
    const res = await GET(mockRequest);
    const body = (res as unknown as { body: { status: string } }).body;
    expect(body.status).toBe("ok");
  });

  it("includes all subscription fields", async () => {
    const res = await GET(mockRequest);
    const body = (
      res as unknown as {
        body: { subscriptions: Record<string, unknown> };
      }
    ).body;
    expect(body.subscriptions).toHaveProperty("total");
    expect(body.subscriptions).toHaveProperty("active");
    expect(body.subscriptions).toHaveProperty("degraded");
    expect(body.subscriptions).toHaveProperty("disabled");
  });

  it("includes all delivery_stats fields", async () => {
    const res = await GET(mockRequest);
    const body = (
      res as unknown as {
        body: { delivery_stats: Record<string, unknown> };
      }
    ).body;
    expect(body.delivery_stats).toHaveProperty("total");
    expect(body.delivery_stats).toHaveProperty("delivered");
    expect(body.delivery_stats).toHaveProperty("failed");
    expect(body.delivery_stats).toHaveProperty("pending");
    expect(body.delivery_stats).toHaveProperty("dlq");
    expect(body.delivery_stats).toHaveProperty("success_rate_pct");
  });

  it("checked_at is a valid ISO-8601 timestamp", async () => {
    const res = await GET(mockRequest);
    const body = (res as unknown as { body: { checked_at: string } }).body;
    expect(new Date(body.checked_at).toISOString()).toBe(body.checked_at);
  });

  it("handles request with custom correlation header", async () => {
    const req = new Request("http://localhost:3000/api/webhooks/health", {
      headers: { "x-correlation-id": "test-corr-id-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns 500 error envelope when an unexpected error is thrown", async () => {
    // Force new Date().toISOString() — called inside the GET handler — to throw
    // so the catch branch (line 48 of route.ts) is exercised.
    const originalToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = () => {
      throw new Error("simulated clock failure");
    };

    try {
      const res = await GET();
      expect(res.status).toBe(500);

      const body = (
        res as unknown as { body: { error: { code: string; message: string; request_id: string } } }
      ).body;
      expect(body.error).toHaveProperty("code", "INTERNAL_SERVER_ERROR");
      expect(body.error).toHaveProperty(
        "message",
        "Failed to retrieve webhook health stats.",
      );
      expect(body.error).toHaveProperty("request_id");
    } finally {
      // Always restore — prevents test pollution.
      Date.prototype.toISOString = originalToISOString;
    }
  });
});




describe("deriveHealthStatus", () => {
  const healthySubs: WebhookSubscriptionStats = {
    total: 10,
    active: 10,
    degraded: 0,
    disabled: 0,
  };

  it("returns 'ok' when no degraded subscriptions and no DLQ entries", () => {
    expect(deriveHealthStatus(healthySubs, emptyStats)).toBe("ok");
  });

  it("returns 'degraded' when any subscriptions are degraded", () => {
    const subs: WebhookSubscriptionStats = { ...healthySubs, degraded: 1 };
    expect(deriveHealthStatus(subs, emptyStats)).toBe("degraded");
  });

  it("returns 'degraded' when DLQ depth > 0", () => {
    const stats: WebhookDeliveryStats = { ...emptyStats, dlq: 3 };
    expect(deriveHealthStatus(healthySubs, stats)).toBe("degraded");
  });

  it("returns 'unhealthy' when more than 50% of subscriptions are degraded or disabled", () => {
    const subs: WebhookSubscriptionStats = {
      total: 10,
      active: 3,
      degraded: 4,
      disabled: 3,
    };
    expect(deriveHealthStatus(subs, emptyStats)).toBe("unhealthy");
  });

  it("returns 'ok' for empty subscription set (0 total)", () => {
    const emptySubs: WebhookSubscriptionStats = {
      total: 0,
      active: 0,
      degraded: 0,
      disabled: 0,
    };
    expect(deriveHealthStatus(emptySubs, emptyStats)).toBe("ok");
  });
});
