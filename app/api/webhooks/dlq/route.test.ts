/** @jest-environment node */

/**
 * Tests for /api/webhooks/dlq
 *
 * GET  — admin-only list of dead-letter entries for the settings console.
 * POST — legacy DLQ intake: 200 for JSON objects, canonical 400/500 errors.
 */

import { GET, POST } from "./route";
import { signToken } from "@/app/lib/auth";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";
import type { DLQEntry } from "@/app/lib/webhook-delivery";

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

function postRequest(body: string) {
  return new Request("http://localhost/api/webhooks/dlq", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }) as unknown as import("next/server").NextRequest;
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
  it("returns 200 { received: true } for a valid JSON body", async () => {
    const res = await POST(postRequest(JSON.stringify({ event: "payment.failed", id: "evt_1" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
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
