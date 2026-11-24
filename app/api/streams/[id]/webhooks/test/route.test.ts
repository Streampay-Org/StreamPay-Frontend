/**
 * @jest-environment node
 *
 * Focused tests for POST /api/streams/:id/webhooks/test
 *
 * Covers:
 *   - Happy path: 202 with synthetic payload (preview + dispatch)
 *   - Default event type when body is omitted
 *   - Custom event_type from request body
 *   - endpoint_url dispatch with delivery result
 *   - 404 for unknown stream
 *   - 400 for invalid / unknown event_type
 *   - 400 for malformed JSON body
 *   - 400 for invalid endpoint_url
 *   - 400 for non-string endpoint_url / event_type
 *   - Rate limiting integration
 *   - Delivery failure handling
 *   - Response shape: required fields present
 *   - Correlation context propagation
 */

import { POST } from "./route";
import { db, resetDb } from "@/app/lib/db";

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockDeliveryResult: {
  success: boolean;
  statusCode?: number;
  error?: string;
  shouldRetry: boolean;
  nextRetryAt?: string;
} = { success: true, statusCode: 200, shouldRetry: false };

let mockDeliveryCallCount = 0;
let mockDeliveryArgs: Array<{
  endpoint: { id: string; url: string; maxRetries: number };
  event: { id: string; eventType: string; streamId: string; data: Record<string, unknown>; timestamp: string };
  deliveryId: string;
  attemptNumber: number;
}> = [];

jest.mock("@/app/lib/webhook-delivery", () => ({
  webhookDeliveryClient: {
    attemptDelivery: jest.fn().mockImplementation(
      async (
        endpoint: { id: string; url: string; maxRetries: number },
        event: { id: string; eventType: string; streamId: string; data: Record<string, unknown>; timestamp: string },
        deliveryId: string,
        attemptNumber: number,
      ) => {
        mockDeliveryCallCount++;
        mockDeliveryArgs.push({ endpoint, event, deliveryId, attemptNumber });
        return mockDeliveryResult;
      },
    ),
  },
}));

jest.mock("@/app/lib/rate-limit", () => ({
  checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 59 }),
  getClientIdentity: jest.fn().mockReturnValue({ type: "ip" as const, value: "127.0.0.1", displayValue: "127.0.0.1" }),
  rateLimitResponse: jest.fn().mockReturnValue({ status: 429, json: () => ({}) }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> };
function ctx(id: string): Ctx {
  return { params: Promise.resolve({ id }) };
}

function testReq(
  streamId: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/api/streams/${streamId}/webhooks/test`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Seed stream IDs from in-memory.ts
const ACTIVE_STREAM = "stream-ada"; // status: active

beforeEach(() => {
  resetDb();
  mockDeliveryResult = { success: true, statusCode: 200, shouldRetry: false };
  mockDeliveryCallCount = 0;
  mockDeliveryArgs = [];
  jest.clearAllMocks();
});

// ─── Happy path ─────────────────────────────────────────────────────────────

describe("happy path", () => {
  it("returns 202 Accepted for an existing stream with no body", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    expect(res.status).toBe(202);
  });

  it("defaults to event_type 'stream.test' when no body is provided", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const body = await res.json();
    expect(body.data.event_type).toBe("stream.test");
  });

  it("returns a synthetic payload with required fields", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();

    expect(data).toHaveProperty("delivery_id");
    expect(data).toHaveProperty("stream_id", ACTIVE_STREAM);
    expect(data).toHaveProperty("event_type");
    expect(data).toHaveProperty("dispatched_at");
    expect(data).toHaveProperty("synthetic", true);
  });

  it("dispatched_at is a valid ISO-8601 UTC timestamp", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();
    const parsed = new Date(data.dispatched_at as string);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(data.dispatched_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("accepts a valid custom event_type in the body", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { event_type: "stream.paused" }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data.event_type).toBe("stream.paused");
  });

  it("each call generates a unique delivery_id", async () => {
    const res1 = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const res2 = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const id1 = (await res1.json()).data.delivery_id;
    const id2 = (await res2.json()).data.delivery_id;
    expect(id1).not.toBe(id2);
  });

  it("does not dispatch when no endpoint_url is provided", async () => {
    await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    expect(mockDeliveryCallCount).toBe(0);
  });

  it("returns no delivery field when no endpoint_url is provided", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();
    expect(data.delivery).toBeUndefined();
  });
});

// ─── 404 for unknown stream ─────────────────────────────────────────────────

describe("stream not found", () => {
  it("returns 404 STREAM_NOT_FOUND for an unknown stream id", async () => {
    const res = await POST(
      testReq("stream-does-not-exist"),
      ctx("stream-does-not-exist"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("STREAM_NOT_FOUND");
  });

  it("does not mutate any stream on 404", async () => {
    const before = db.streams.get(ACTIVE_STREAM);
    await POST(testReq("stream-ghost"), ctx("stream-ghost"));
    const after = db.streams.get(ACTIVE_STREAM);
    expect(after).toEqual(before);
  });
});

// ─── Input validation ───────────────────────────────────────────────────────

describe("input validation", () => {
  it("returns 400 BAD_REQUEST for an unknown event_type", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { event_type: "stream.explode" }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("stream.explode");
  });

  it("returns 400 BAD_REQUEST when event_type is not a string", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { event_type: 42 }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 BAD_REQUEST for malformed JSON body", async () => {
    const req = new Request(
      `http://localhost/api/streams/${ACTIVE_STREAM}/webhooks/test`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-length": "10",
        },
        body: "{ not json",
      },
    );
    const res = await POST(req, ctx(ACTIVE_STREAM));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
  });

  it("accepts an empty body without error", async () => {
    const res = await POST(testReq(ACTIVE_STREAM, {}), ctx(ACTIVE_STREAM));
    expect(res.status).toBe(202);
  });

  it("ignores unknown fields in the body", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { unrelated: "field", also: 123 }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
  });
});

// ─── endpoint_url validation ────────────────────────────────────────────────

describe("endpoint_url validation", () => {
  it("returns 400 when endpoint_url is not a string", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { endpoint_url: 123 }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("endpoint_url");
  });

  it("returns 400 for an invalid URL string", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { endpoint_url: "not-a-url" }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for a non-http protocol", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, { endpoint_url: "ftp://example.com/hook" }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("http");
  });

  it("accepts an https endpoint_url", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
  });

  it("accepts an http endpoint_url", async () => {
    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "http://localhost:3000/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
  });
});

// ─── Webhook dispatch ───────────────────────────────────────────────────────

describe("webhook dispatch", () => {
  it("dispatches to the endpoint when endpoint_url is provided", async () => {
    await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    expect(mockDeliveryCallCount).toBe(1);
  });

  it("passes the correct endpoint object to the delivery client", async () => {
    await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );

    expect(mockDeliveryArgs).toHaveLength(1);
    const { endpoint } = mockDeliveryArgs[0];
    expect(endpoint.url).toBe("https://example.com/webhooks");
    expect(endpoint.maxRetries).toBe(0);
    expect(endpoint.id).toMatch(/^wh_test_endpoint_/);
  });

  it("passes a synthetic WebhookEvent with the correct event type", async () => {
    await POST(
      testReq(ACTIVE_STREAM, {
        event_type: "stream.paused",
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );

    const { event } = mockDeliveryArgs[0];
    expect(event.eventType).toBe("stream.paused");
    expect(event.streamId).toBe(ACTIVE_STREAM);
    expect(event.data).toHaveProperty("synthetic", true);
    expect(event.data).toHaveProperty("stream_id", ACTIVE_STREAM);
  });

  it("uses attemptNumber 1", async () => {
    await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );

    expect(mockDeliveryArgs[0].attemptNumber).toBe(1);
  });

  it("returns delivery result in the response on success", async () => {
    mockDeliveryResult = {
      success: true,
      statusCode: 200,
      shouldRetry: false,
    };

    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    const { data } = await res.json();
    expect(data.delivery).toEqual({
      success: true,
      status_code: 200,
      error: undefined,
    });
  });

  it("returns delivery result in the response on failure", async () => {
    mockDeliveryResult = {
      success: false,
      statusCode: 500,
      error: "Internal Server Error",
      shouldRetry: false,
    };

    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    const { data } = await res.json();
    expect(data.delivery).toEqual({
      success: false,
      status_code: 500,
      error: "Internal Server Error",
    });
  });

  it("returns 202 even when delivery fails (best-effort)", async () => {
    mockDeliveryResult = {
      success: false,
      statusCode: 503,
      error: "Service Unavailable",
      shouldRetry: true,
    };

    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
  });

  it("handles delivery client throwing an exception gracefully", async () => {
    const webhookDeliveryClient =
      require("@/app/lib/webhook-delivery").webhookDeliveryClient;
    webhookDeliveryClient.attemptDelivery.mockRejectedValueOnce(
      new Error("Network timeout"),
    );

    const res = await POST(
      testReq(ACTIVE_STREAM, {
        endpoint_url: "https://example.com/webhooks",
      }),
      ctx(ACTIVE_STREAM),
    );
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data.delivery).toEqual({
      success: false,
      error: "Network timeout",
    });
  });
});

// ─── All allowed event types ────────────────────────────────────────────────

describe("all allowed event types", () => {
  const allowedTypes = [
    "stream.test",
    "stream.created",
    "stream.updated",
    "stream.paused",
    "stream.resumed",
    "stream.stopped",
    "stream.cancelled",
    "stream.settled",
  ];

  it.each(allowedTypes)(
    "accepts event_type '%s'",
    async (eventType) => {
      const res = await POST(
        testReq(ACTIVE_STREAM, { event_type: eventType }),
        ctx(ACTIVE_STREAM),
      );
      expect(res.status).toBe(202);
      const { data } = await res.json();
      expect(data.event_type).toBe(eventType);
    },
  );
});

// ─── Response shape ─────────────────────────────────────────────────────────

describe("response shape", () => {
  it("includes request_id in the payload", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();
    expect(typeof data.request_id).toBe("string");
    expect(data.request_id.length).toBeGreaterThan(0);
  });

  it("includes stream status in data", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();
    expect(data.data).toHaveProperty("status");
    expect(data.data).toHaveProperty("stream_id", ACTIVE_STREAM);
  });

  it("delivery_id starts with 'wh_test_'", async () => {
    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    const { data } = await res.json();
    expect(data.delivery_id).toMatch(/^wh_test_/);
  });
});

// ─── Rate limiting ──────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("applies write rate limit to the endpoint", async () => {
    const { checkRateLimit } = require("@/app/lib/rate-limit");
    checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfter: 30,
    });

    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    expect(res.status).toBe(429);
  });

  it("allows the request when rate limit permits", async () => {
    const { checkRateLimit } = require("@/app/lib/rate-limit");
    checkRateLimit.mockResolvedValueOnce({
      allowed: true,
      remaining: 59,
    });

    const res = await POST(testReq(ACTIVE_STREAM), ctx(ACTIVE_STREAM));
    expect(res.status).toBe(202);
  });
});
