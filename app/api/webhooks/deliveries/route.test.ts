/**
 * Tests for GET /api/webhooks/deliveries
 */

import { GET } from "./route";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";
import { encodeCompositeCursor } from "@/app/lib/db";

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

function makeRequest(params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams(params);
  return {
    nextUrl: { searchParams },
    headers: { get: () => null },
  } as unknown as import("next/server").NextRequest;
}

const endpoint = { id: "endpoint-1", url: "https://example.com/hook", maxRetries: 3 };

function makeEvent(id: string) {
  return {
    id: `event-${id}`,
    eventType: "stream.created",
    streamId: "stream-1",
    data: {},
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

/** Creates a delivery with a fixed createdAt by freezing Date around the call. */
function createDeliveryAt(deliveryId: string, createdAt: string) {
  const realDate = Date;
  const fixed = new realDate(createdAt);
  jest.spyOn(global, "Date").mockImplementation(() => fixed as unknown as Date);
  try {
    return webhookDeliveryStore.createDelivery(deliveryId, endpoint, makeEvent(deliveryId));
  } finally {
    (global.Date as unknown as jest.SpyInstance).mockRestore();
  }
}

describe("GET /api/webhooks/deliveries", () => {
  afterEach(() => {
    webhookDeliveryStore.clear();
  });

  it("returns 200 with deliveries array and default limit", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = (res as unknown as { body: { deliveries: unknown[]; limit: number } }).body;
    expect(Array.isArray(body.deliveries)).toBe(true);
    expect(body.limit).toBe(20);
  });

  it("respects a valid limit param", async () => {
    const res = await GET(makeRequest({ limit: "50" }));
    expect(res.status).toBe(200);
    const body = (res as unknown as { body: { limit: number } }).body;
    expect(body.limit).toBe(50);
  });

  it("returns 400 for limit = 0", async () => {
    const res = await GET(makeRequest({ limit: "0" }));
    expect(res.status).toBe(400);
    const body = (res as unknown as { body: { error: { code: string } } }).body;
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for limit > 100", async () => {
    const res = await GET(makeRequest({ limit: "101" }));
    expect(res.status).toBe(400);
    const body = (res as unknown as { body: { error: { code: string } } }).body;
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for non-numeric limit", async () => {
    const res = await GET(makeRequest({ limit: "abc" }));
    expect(res.status).toBe(400);
    const body = (res as unknown as { body: { error: { code: string } } }).body;
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("passes a valid cursor through in the response", async () => {
    const validCursor = encodeCompositeCursor("2026-01-01T00:00:00.000Z", "d1");
    const res = await GET(makeRequest({ cursor: validCursor }));
    expect(res.status).toBe(200);
    const body = (res as unknown as { body: { cursor: string } }).body;
    expect(body.cursor).toBe(validCursor);
  });

  it("returns null cursor when none provided", async () => {
    const res = await GET(makeRequest());
    const body = (res as unknown as { body: { cursor: null } }).body;
    expect(body.cursor).toBeNull();
  });

  it("returns 422 for a malformed cursor", async () => {
    const res = await GET(makeRequest({ cursor: "tok_xyz" }));
    expect(res.status).toBe(422);
    const body = (res as unknown as { body: { error: { code: string } } }).body;
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("error envelope has code, message, request_id", async () => {
    const res = await GET(makeRequest({ limit: "0" }));
    const body = (res as unknown as { body: { error: Record<string, unknown> } }).body;
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
    expect(body.error).toHaveProperty("request_id");
  });

  describe("cursor pagination over (createdAt, deliveryId)", () => {
    it("returns deliveries newest-first and reports meta.hasNext/nextCursor", async () => {
      createDeliveryAt("d1", "2026-01-01T00:00:00.000Z");
      createDeliveryAt("d2", "2026-01-02T00:00:00.000Z");
      createDeliveryAt("d3", "2026-01-03T00:00:00.000Z");

      const res = await GET(makeRequest({ limit: "2" }));
      expect(res.status).toBe(200);
      const body = (res as unknown as {
        body: {
          deliveries: { deliveryId: string }[];
          meta: { hasNext: boolean; nextCursor: string | null; total: number };
        };
      }).body;

      expect(body.deliveries.map((d) => d.deliveryId)).toEqual(["d3", "d2"]);
      expect(body.meta.hasNext).toBe(true);
      expect(body.meta.nextCursor).not.toBeNull();
      expect(body.meta.total).toBe(3);
    });

    it("advances to the next page without repeating or skipping records", async () => {
      createDeliveryAt("d1", "2026-01-01T00:00:00.000Z");
      createDeliveryAt("d2", "2026-01-02T00:00:00.000Z");
      createDeliveryAt("d3", "2026-01-03T00:00:00.000Z");

      const page1 = await GET(makeRequest({ limit: "2" }));
      const page1Body = (page1 as unknown as {
        body: { deliveries: { deliveryId: string }[]; meta: { nextCursor: string } };
      }).body;

      const page2 = await GET(makeRequest({ limit: "2", cursor: page1Body.meta.nextCursor }));
      const page2Body = (page2 as unknown as {
        body: {
          deliveries: { deliveryId: string }[];
          meta: { hasNext: boolean; nextCursor: string | null };
        };
      }).body;

      expect(page2Body.deliveries.map((d) => d.deliveryId)).toEqual(["d1"]);
      expect(page2Body.meta.hasNext).toBe(false);
      expect(page2Body.meta.nextCursor).toBeNull();
    });
  });
});
