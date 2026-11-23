/** @jest-environment node */

/**
 * Tests for /api/webhooks/dlq
 *
 * GET  — admin-only list of dead-letter entries for the settings console.
 * POST — legacy DLQ intake: 200 for JSON objects, canonical 400/500 errors.
 */

jest.mock("@/src/metrics/registry", () => ({
  observeWebhookDelivery: jest.fn(),
}));

import { GET, POST } from "./route";
import { signToken } from "@/app/lib/auth";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";
import type { DLQEntry } from "@/app/lib/webhook-delivery";
import * as outbox from "@/lib/outbox";

function dlqEntry(overrides: Partial<DLQEntry> = {}): DLQEntry {
  const attempt = { attemptNumber: 1, timestamp: "2026-01-01T00:00:00.000Z", statusCode: 500 };
  return {
    id: "dlq-1",
    deliveryId: "del-1",
    endpointId: "ep-1",
    endpointUrl: "https://example.com/hook",
    eventId: "evt-1",
    eventType: "stream.created",
    payload: {
      id: "evt-1",
      eventType: "stream.created",
      streamId: "stream-1",
      data: { sensitive: "payload" },
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    reason: "max retries exceeded",
    allAttempts: [attempt],
    lastAttempt: attempt,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as DLQEntry;
}

function getRequest(role?: string): Request {
  const headers: Record<string, string> = {};
  if (role) {
    headers.authorization = `Bearer ${signToken(`${role}-wallet`, { role, actorId: `${role}-1` })}`;
  }
  return new Request("http://localhost/api/webhooks/dlq", { headers });
}

function postRequest(body: string, role: string | null = "admin") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (role) {
    headers.authorization = `Bearer ${signToken(`${role}-wallet`, { role, actorId: `${role}-1` })}`;
  }
  return new Request("http://localhost/api/webhooks/dlq", {
    method: "POST",
    headers,
    body,
  }) as unknown as import("next/server").NextRequest;
}

function validStructuredPayload(overrides: {
  endpoint?: Record<string, unknown>;
  event?: Record<string, unknown>;
} = {}) {
  return {
    endpoint: {
      id: "ep-1",
      url: "https://hooks.example.com/streampay",
      maxRetries: 3,
      ...overrides.endpoint,
    },
    event: {
      id: "evt-1",
      eventType: "stream.created",
      streamId: "stream-1",
      data: { amount: "100" },
      timestamp: "2026-01-01T00:00:00.000Z",
      ...overrides.event,
    },
  };
}

describe("GET /api/webhooks/dlq", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns entries newest first for an admin", async () => {
    jest.spyOn(webhookDeliveryStore, "getAllDLQEntries").mockReturnValue([
      dlqEntry({ id: "dlq-old", createdAt: "2026-01-01T00:00:00.000Z" }),
      dlqEntry({
        id: "dlq-new",
        createdAt: "2026-02-01T00:00:00.000Z",
        replayedAt: "2026-02-02T00:00:00.000Z",
        replayedDeliveryId: "del-9",
      }),
    ]);

    const res = await GET(getRequest("admin"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta.total).toBe(2);
    expect(body.data.map((e: { id: string }) => e.id)).toEqual(["dlq-new", "dlq-old"]);
    expect(body.data[0]).toMatchObject({
      replayedAt: "2026-02-02T00:00:00.000Z",
      replayedDeliveryId: "del-9",
      reason: "max retries exceeded",
    });
    expect(body.data[1].replayedAt).toBeNull();
    expect(body.data[1].attempts).toHaveLength(1);
  });

  it("does not include the raw event payload", async () => {
    jest.spyOn(webhookDeliveryStore, "getAllDLQEntries").mockReturnValue([dlqEntry()]);
    const res = await GET(getRequest("admin"));
    const body = await res.json();
    expect(body.data[0]).not.toHaveProperty("payload");
  });

  it("returns an empty list when the queue is empty", async () => {
    jest.spyOn(webhookDeliveryStore, "getAllDLQEntries").mockReturnValue([]);
    const res = await GET(getRequest("admin"));
    expect(await res.json()).toEqual({ data: [], meta: { total: 0 } });
  });

  it("returns 401 without a bearer token", async () => {
    const spy = jest.spyOn(webhookDeliveryStore, "getAllDLQEntries");
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin role", async () => {
    const spy = jest.spyOn(webhookDeliveryStore, "getAllDLQEntries");
    const res = await GET(getRequest("user"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/dlq", () => {
  beforeEach(() => {
    outbox.setOutboxStore(new outbox.InMemoryOutboxStore());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await POST(postRequest(JSON.stringify(validStructuredPayload()), null));
    expect(res.status).toBe(401);
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it("returns 403 for a non-admin JWT", async () => {
    const res = await POST(postRequest(JSON.stringify(validStructuredPayload()), "user"));
    expect(res.status).toBe(403);
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it("enqueues a structured payload once and deduplicates retries", async () => {
    const payload = JSON.stringify(validStructuredPayload());

    const first = await POST(postRequest(payload));
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toEqual({
      received: true,
      enqueued: true,
      outboxId: expect.any(String),
      duplicate: false,
    });
    expect(outbox.getOutboxStore().list()).toHaveLength(1);

    const second = await POST(postRequest(payload));
    expect(second.status).toBe(202);
    const secondBody = await second.json();
    expect(secondBody).toEqual({
      received: true,
      enqueued: true,
      outboxId: firstBody.outboxId,
      duplicate: true,
    });
    expect(outbox.getOutboxStore().list()).toHaveLength(1);
  });

  it("allows OutboxDrainWorker.drain() to pick up the enqueued entry", async () => {
    const res = await POST(postRequest(JSON.stringify(validStructuredPayload())));
    expect(res.status).toBe(202);

    const processDelivery = jest.fn().mockResolvedValue({ success: true, attempts: 1 });
    const drainer = new outbox.OutboxDrainWorker({
      store: outbox.getOutboxStore(),
      deliveryWorker: { processDelivery } as unknown as import("@/app/lib/webhook-delivery-worker").WebhookDeliveryWorker,
    });

    const result = await drainer.drain();
    expect(result).toEqual({ dispatched: 1, failed: 0, total: 1 });
    expect(processDelivery).toHaveBeenCalledTimes(1);
  });

  it("returns 200 { received: true } for a legacy unstructured JSON body", async () => {
    const res = await POST(postRequest(JSON.stringify({ event: "payment.failed", id: "evt_1" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it("returns 200 { received: true } for an empty object", async () => {
    const res = await POST(postRequest(JSON.stringify({})));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it.each([
    ["endpoint present without event", { endpoint: validStructuredPayload().endpoint }, "event"],
    ["event present without endpoint", { event: validStructuredPayload().event }, "endpoint"],
    ["missing endpoint.url", validStructuredPayload({ endpoint: { url: "" } }), "endpoint.url"],
    ["negative endpoint.maxRetries", validStructuredPayload({ endpoint: { maxRetries: -1 } }), "endpoint.maxRetries"],
    ["non-ISO event.timestamp", validStructuredPayload({ event: { timestamp: "not-a-date" } }), "event.timestamp"],
  ])("returns 422 VALIDATION_ERROR for %s", async (_label, payload, expectedField) => {
    const res = await POST(postRequest(JSON.stringify(payload)));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain(expectedField);
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it.each([
    ["loopback IPv4", "http://127.0.0.1/hook"],
    ["localhost", "http://localhost:3000/hook"],
    ["private 10.x", "http://10.0.0.1/hook"],
    ["private 192.168.x", "http://192.168.1.10/hook"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback IPv6", "http://[::1]/hook"],
    ["file scheme", "file:///etc/passwd"],
  ])("rejects SSRF endpoint.url (%s) with 422", async (_label, url) => {
    const res = await POST(postRequest(JSON.stringify(validStructuredPayload({ endpoint: { url } }))));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("endpoint.url");
    expect(outbox.getOutboxStore().list()).toHaveLength(0);
  });

  it("returns 500 WEBHOOK_PROCESSING_FAILED without leaking internals when enqueue throws", async () => {
    jest.spyOn(outbox.getOutboxStore(), "append").mockImplementation(() => {
      throw new Error("secret database connection string");
    });

    const res = await POST(postRequest(JSON.stringify(validStructuredPayload())));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("WEBHOOK_PROCESSING_FAILED");
    expect(body.error.message).not.toContain("secret database");
  });

  it.each([
    ["null", "null"],
    ["a string", JSON.stringify("just a string")],
    ["an array", JSON.stringify([1, 2, 3])],
  ])("returns 400 canonical error when body is %s", async (_label, raw) => {
    const res = await POST(postRequest(raw));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("request_id");
  });

  it("returns 500 canonical error when the body is not valid JSON", async () => {
    const res = await POST(postRequest("{not json"));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("WEBHOOK_PROCESSING_FAILED");
  });
});
