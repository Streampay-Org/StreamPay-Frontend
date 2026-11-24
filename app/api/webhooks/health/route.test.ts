/**
 * Tests for GET /api/webhooks/health
 */

import { GET } from "./route";
import {
  DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD,
  computeSuccessRatePct,
  deriveHealthStatus,
  getSubscriptionStats,
  type WebhookDeliveryStats,
  type WebhookHealthResponse,
  type WebhookSubscriptionStats,
} from "./health";
import {
  setWebhookSubscriptionStore,
  type WebhookSubscription,
} from "@app/lib/webhook-store";
import { webhookDeliveryStore } from "@app/lib/webhook-delivery-store";
import { WEBHOOK_TIMEOUT_MS } from "@src/middleware/timeout";
import type { WebhookEndpoint, WebhookEvent } from "@app/lib/webhook-delivery";

jest.mock("next/server", () => {
  class MockNextResponse {
    status: number;
    body: unknown;
    headers: Headers;
    constructor(body?: BodyInit | null, init?: { status?: number; headers?: HeadersInit }) {
      this.status = init?.status ?? 200;
      this.body = typeof body === "string" ? JSON.parse(body) : body;
      this.headers = new Headers(init?.headers);
    }
    async json() {
      return this.body;
    }
    static json<T>(body: T, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(JSON.stringify(body), init);
    }
  }
  return { NextResponse: MockNextResponse };
});

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
  stale: 0,
  success_rate_pct: 100,
};

function makeSubscription(
  id: string,
  status: "active" | "inactive" = "active",
): WebhookSubscription {
  return {
    id,
    url: `https://example.com/${id}`,
    eventTypes: ["stream.created"],
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeEndpoint(id: string): WebhookEndpoint {
  return {
    id,
    url: `https://example.com/${id}`,
    maxRetries: 3,
  };
}

function makeEvent(id: string): WebhookEvent {
  return {
    id: `event-${id}`,
    eventType: "stream.created",
    streamId: "stream-1",
    data: {},
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("GET /api/webhooks/health", () => {
  beforeEach(() => {
    webhookDeliveryStore.clear();
    setWebhookSubscriptionStore({
      list: async () => [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    webhookDeliveryStore.clear();
    setWebhookSubscriptionStore(null);
  });

  it("returns 200 with expected shape and all-zero ok response when stores are empty", async () => {
    const res = await GET(mockRequest);
    expect(res.status).toBe(200);

    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.status).toBe("ok");
    expect(new Date(body.checked_at).toISOString()).toBe(body.checked_at);
    expect(body.subscriptions).toEqual({
      total: 0,
      active: 0,
      degraded: 0,
      disabled: 0,
    });
    expect(body.delivery_stats).toEqual({
      total: 0,
      delivered: 0,
      failed: 0,
      pending: 0,
      dlq: 0,
      stale: 0,
      success_rate_pct: 100,
    });
  });

  it("handles request with custom correlation header", async () => {
    const req = new Request("http://localhost:3000/api/webhooks/health", {
      headers: { "x-correlation-id": "test-corr-id-123" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns accurate counts and success_rate_pct for seeded deliveries", async () => {
    setWebhookSubscriptionStore({
      list: async () => [makeSubscription("ep-1", "active")],
    });

    const ep = makeEndpoint("ep-1");
    webhookDeliveryStore.createDelivery("d1", ep, makeEvent("1"));
    webhookDeliveryStore.markDelivered("d1");

    webhookDeliveryStore.createDelivery("d2", ep, makeEvent("2"));
    webhookDeliveryStore.markDelivered("d2");

    const d3 = webhookDeliveryStore.createDelivery("d3", ep, makeEvent("3"));
    d3.status = "failed";

    webhookDeliveryStore.createDelivery("d4", ep, makeEvent("4"));

    const res = await GET(mockRequest);
    expect(res.status).toBe(200);

    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.status).toBe("ok");
    expect(body.subscriptions).toEqual({
      total: 1,
      active: 1,
      degraded: 0,
      disabled: 0,
    });
    expect(body.delivery_stats).toEqual({
      total: 4,
      delivered: 2,
      failed: 1,
      pending: 1,
      dlq: 0,
      stale: 0,
      success_rate_pct: 66.67,
    });
  });

  it("returns success_rate_pct 100 when there are zero finalised deliveries", async () => {
    const ep = makeEndpoint("ep-1");
    webhookDeliveryStore.createDelivery("d-pending", ep, makeEvent("1"));

    const res = await GET(mockRequest);
    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.delivery_stats.pending).toBe(1);
    expect(body.delivery_stats.success_rate_pct).toBe(100);
    expect(body.status).toBe("ok");
  });

  it("flips status from ok to degraded when a pending delivery is older than WEBHOOK_TIMEOUT_MS", async () => {
    jest.useFakeTimers();
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    jest.setSystemTime(t0);

    const ep = makeEndpoint("ep-1");
    webhookDeliveryStore.createDelivery("d-pending", ep, makeEvent("1"));

    // Exactly at WEBHOOK_TIMEOUT_MS -> fresh, still ok
    jest.setSystemTime(new Date(t0.getTime() + WEBHOOK_TIMEOUT_MS));
    const freshRes = await GET(mockRequest);
    const freshBody = (freshRes as unknown as { body: WebhookHealthResponse })
      .body;
    expect(freshBody.delivery_stats.stale).toBe(0);
    expect(freshBody.status).toBe("ok");

    // 1 ms past WEBHOOK_TIMEOUT_MS -> stale, flips to degraded
    jest.setSystemTime(new Date(t0.getTime() + WEBHOOK_TIMEOUT_MS + 1));
    const staleRes = await GET(mockRequest);
    const staleBody = (staleRes as unknown as { body: WebhookHealthResponse })
      .body;
    expect(staleBody.delivery_stats.stale).toBe(1);
    expect(staleBody.status).toBe("degraded");
  });

  it("returns degraded when DLQ depth > 0", async () => {
    const ep = makeEndpoint("ep-1");
    webhookDeliveryStore.createDelivery("d-dlq", ep, makeEvent("1"));
    webhookDeliveryStore.recordAttempt("d-dlq", {
      attemptNumber: 1,
      timestamp: new Date().toISOString(),
      statusCode: 500,
    });
    webhookDeliveryStore.moveToDLQ("d-dlq", "max retries");

    const res = await GET(mockRequest);
    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.delivery_stats.dlq).toBe(1);
    expect(body.status).toBe("degraded");
  });

  it("returns unhealthy when all subscriptions are disabled", async () => {
    setWebhookSubscriptionStore({
      list: async () => [
        makeSubscription("ep-1", "inactive"),
        makeSubscription("ep-2", "inactive"),
      ],
    });

    const res = await GET(mockRequest);
    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.subscriptions).toEqual({
      total: 2,
      active: 0,
      degraded: 0,
      disabled: 2,
    });
    expect(body.status).toBe("unhealthy");
  });

  it("marks active subscriptions degraded after consecutive failures and unhealthy when > 50% degraded/disabled", async () => {
    setWebhookSubscriptionStore({
      list: async () => [
        makeSubscription("ep-bad", "active"),
        makeSubscription("ep-off", "inactive"),
        makeSubscription("ep-ok", "active"),
      ],
    });

    const badEp = makeEndpoint("ep-bad");
    for (let i = 0; i < DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD; i += 1) {
      const rec = webhookDeliveryStore.createDelivery(
        `bad-${i}`,
        badEp,
        makeEvent(`bad-${i}`),
      );
      rec.status = "failed";
      rec.finalizedAt = `2026-01-01T00:00:0${i}.000Z`;
    }

    const res = await GET(mockRequest);
    const body = (res as unknown as { body: WebhookHealthResponse }).body;
    expect(body.subscriptions).toEqual({
      total: 3,
      active: 1,
      degraded: 1,
      disabled: 1,
    });
    expect(body.status).toBe("unhealthy");
  });

  it("returns 500 INTERNAL_SERVER_ERROR without leaking details when subscription store throws", async () => {
    setWebhookSubscriptionStore({
      list: async () => {
        throw new Error("postgres connection refused: secret-host:5432");
      },
    });

    const res = await GET(mockRequest);
    expect(res.status).toBe(500);

    const body = (
      res as unknown as {
        body: { error: { code: string; message: string; request_id: string } };
      }
    ).body;
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.error.message).toBe("Failed to retrieve webhook health stats.");
    expect(JSON.stringify(body)).not.toContain("secret-host");
    expect(body.error).toHaveProperty("request_id");
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

describe("computeSuccessRatePct & getSubscriptionStats", () => {
  beforeEach(() => {
    webhookDeliveryStore.clear();
  });

  it("returns 100 when there are no finalised deliveries", () => {
    expect(computeSuccessRatePct(0, 0, 0)).toBe(100);
  });

  it("rounds delivered / (delivered + failed + dlq) to 2 decimals", () => {
    expect(computeSuccessRatePct(2, 1, 0)).toBe(66.67);
    expect(computeSuccessRatePct(1, 0, 2)).toBe(33.33);
    expect(computeSuccessRatePct(5, 0, 0)).toBe(100);
  });

  it("resets consecutive failure streak when a newer delivery succeeded", async () => {
    const ep = makeEndpoint("ep-recovered");
    for (let i = 0; i < DEGRADED_CONSECUTIVE_FAILURE_THRESHOLD; i += 1) {
      const rec = webhookDeliveryStore.createDelivery(
        `old-fail-${i}`,
        ep,
        makeEvent(`f-${i}`),
      );
      rec.status = "failed";
      rec.finalizedAt = `2026-01-01T00:00:0${i}.000Z`;
    }
    const okRec = webhookDeliveryStore.createDelivery(
      "newest-ok",
      ep,
      makeEvent("ok"),
    );
    webhookDeliveryStore.markDelivered("newest-ok");
    okRec.finalizedAt = "2026-01-01T00:01:00.000Z";

    const stats = await getSubscriptionStats(
      { list: async () => [makeSubscription("ep-recovered", "active")] },
      webhookDeliveryStore,
    );
    expect(stats).toEqual({ total: 1, active: 1, degraded: 0, disabled: 0 });
  });
});
