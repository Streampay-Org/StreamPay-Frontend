import { POST } from "./route";

jest.mock("@/app/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
  },
}));

const encoder = new TextEncoder();

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function makeRequest(
  body: unknown,
  shouldThrow = false,
): import("next/server").NextRequest {
  const text = shouldThrow ? "{" : (JSON.stringify(body) ?? "");
  return {
    body: streamFromChunks([text]),
  } as unknown as import("next/server").NextRequest;
}

function makeStreamRequest(
  body: ReadableStream<Uint8Array> | null,
): import("next/server").NextRequest {
  return { body } as unknown as import("next/server").NextRequest;
}

describe("POST /api/webhooks", () => {
  it("returns 200 for a valid webhook payload", async () => {
    const response = await POST(
      makeRequest({
        eventType: "payment.received",
        eventId: "evt_123",
        timestamp: "2026-07-26T12:34:56.000Z",
        source: "grantfox",
        data: { amount: "100", currency: "XLM" },
        metadata: { campaignId: "fwc26" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it("returns 400 when request JSON is invalid", async () => {
    const response = await POST(makeRequest(null, true));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(data.error.message).toBe("Request body must be valid JSON.");
  });

  it("returns 400 EMPTY_BODY for an empty body", async () => {
    const response = await POST(makeStreamRequest(streamFromChunks([])));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("EMPTY_BODY");
  });

  it("returns 413 for a chunked body over the webhook limit", async () => {
    const response = await POST(
      makeStreamRequest(streamFromChunks([new Uint8Array(2 * 1024 * 1024)])),
    );

    expect(response.status).toBe(413);
    const data = await response.json();
    expect(data.error.code).toBe("REQUEST_TOO_LARGE");
    expect(data.error.message).toContain("1048576-byte limit");
    expect(data.error.request_id).toBeDefined();
  });

  it("returns 400 when eventType is missing", async () => {
    const response = await POST(makeRequest({ data: { ok: true } }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(data.error.message).toBe("eventType is required");
  });

  it("returns 400 when eventType is blank", async () => {
    const response = await POST(makeRequest({ eventType: "   " }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(data.error.message).toBe("eventType is required");
  });

  it("returns 400 when unknown fields are present", async () => {
    const response = await POST(makeRequest({ eventType: "payment.received", unexpected: true }));

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(data.error.message).toBe("Unknown fields are not allowed.");
  });
});
