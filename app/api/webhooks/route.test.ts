import { POST } from "./route";
import { generateWebhookSignature } from "@/app/lib/webhook-delivery";
import {
  resetWebhookSecretStore,
  webhookSecretStore,
} from "@/app/lib/webhook-secrets";
import { resetWebhookInboundStore } from "@/app/lib/webhook-inbound-store";
import {
  clearWebhookHandlers,
  registerWebhookHandler,
} from "@/app/lib/webhook-handlers";

jest.mock("@/src/metrics/registry", () => ({
  registry: {
    metrics: jest.fn().mockResolvedValue(""),
    contentType: "text/plain",
  },
  webhookCounter: { inc: jest.fn() },
  webhookDuration: { observe: jest.fn() },
}));

const mockApplyRateLimit = jest.fn();
jest.mock("@/src/middleware/rateLimit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
  withRateLimitHeaders: <T,>(response: T) => response,
}));

jest.mock("@/app/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  getCorrelationContext: jest.fn(() => undefined),
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

let testCallerSeq = 0;
function nextCallerKey(): string {
  testCallerSeq += 1;
  return `test-webhook-caller-${testCallerSeq}`;
}

function makeRequest(
  body: unknown,
  options: {
    shouldThrow?: boolean;
    headers?: Record<string, string>;
  } = {},
): import("next/server").NextRequest {
  const text = options.shouldThrow ? "{" : (JSON.stringify(body) ?? "");
  return {
    body: streamFromChunks([text]),
    headers: new Headers({
      "x-api-key": nextCallerKey(),
      ...(options.headers ?? {}),
    }),
  } as unknown as import("next/server").NextRequest;
}

function makeSignedRequest(
  body: Record<string, unknown>,
  options: {
    secret?: string;
    timestamp?: string;
    eventId?: string;
    rawBodyOverride?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): import("next/server").NextRequest {
  const rawBody = JSON.stringify(body);
  const timestamp =
    options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const eventId =
    options.eventId ?? (typeof body.eventId === "string" ? body.eventId : "evt_default");
  const secret = options.secret ?? webhookSecretStore.getCurrentSecret();
  const signature = generateWebhookSignature(rawBody, secret, timestamp, eventId);

  const headers = new Headers({
    "content-type": "application/json",
    "x-api-key": nextCallerKey(),
    "x-streampay-signature": signature,
    "x-streampay-timestamp": timestamp,
    ...(options.extraHeaders ?? {}),
  });

  return {
    body: streamFromChunks([options.rawBodyOverride ?? rawBody]),
    headers,
  } as unknown as import("next/server").NextRequest;
}

function makeStreamRequest(
  body: ReadableStream<Uint8Array> | null,
): import("next/server").NextRequest {
  return {
    body,
    headers: new Headers({ "x-api-key": nextCallerKey() }),
  } as unknown as import("next/server").NextRequest;
}

describe("POST /api/webhooks", () => {
  const originalTolerance = process.env.WEBHOOK_REPLAY_TOLERANCE_MS;

  beforeEach(() => {
    mockApplyRateLimit.mockReset();
    mockApplyRateLimit.mockResolvedValue({ allowed: true, headers: {} });
    resetWebhookSecretStore("primary-webhook-secret-32-chars-minimum-01");
    resetWebhookInboundStore();
    clearWebhookHandlers();
    delete process.env.WEBHOOK_REPLAY_TOLERANCE_MS;
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalTolerance === undefined) {
      delete process.env.WEBHOOK_REPLAY_TOLERANCE_MS;
    } else {
      process.env.WEBHOOK_REPLAY_TOLERANCE_MS = originalTolerance;
    }
  });

  it("returns 200 for a valid signed webhook payload with a registered handler", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const payload = {
      eventType: "payment.received",
      eventId: "evt_123",
      timestamp: "2026-07-26T12:34:56.000Z",
      source: "grantfox",
      data: { amount: "100", currency: "XLM" },
      metadata: { campaignId: "fwc26" },
    };

    const response = await POST(makeSignedRequest(payload));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("returns 202 { success: true, handled: false } for an unknown event type", async () => {
    const response = await POST(
      makeSignedRequest({
        eventType: "unregistered.event",
        eventId: "evt_unknown_1",
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      success: true,
      handled: false,
    });
  });

  it("returns 401 INVALID_SIGNATURE when signature headers are missing", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const response = await POST(
      makeRequest({
        eventType: "payment.received",
        eventId: "evt_unsigned",
      }),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_SIGNATURE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE when signed with the wrong secret", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const response = await POST(
      makeSignedRequest(
        { eventType: "payment.received", eventId: "evt_wrong_secret" },
        { secret: "wrong-webhook-secret-32-chars-minimum-99" },
      ),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_SIGNATURE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 INVALID_SIGNATURE when body is modified after signing", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const original = {
      eventType: "payment.received",
      eventId: "evt_tampered",
      data: { amount: "100" },
    };
    const tampered = JSON.stringify({
      eventType: "payment.received",
      eventId: "evt_tampered",
      data: { amount: "999999" },
    });

    const response = await POST(
      makeSignedRequest(original, { rawBodyOverride: tampered }),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_SIGNATURE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 REPLAY_WINDOW_EXCEEDED for stale timestamps", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const staleTimestamp = Math.floor((Date.now() - 400_000) / 1000).toString();
    const response = await POST(
      makeSignedRequest(
        { eventType: "payment.received", eventId: "evt_stale" },
        { timestamp: staleTimestamp },
      ),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("REPLAY_WINDOW_EXCEEDED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 REPLAY_WINDOW_EXCEEDED for timestamps too far in the future", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const futureTimestamp = Math.floor((Date.now() + 400_000) / 1000).toString();
    const response = await POST(
      makeSignedRequest(
        { eventType: "payment.received", eventId: "evt_future" },
        { timestamp: futureTimestamp },
      ),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("REPLAY_WINDOW_EXCEEDED");
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects configurable WEBHOOK_REPLAY_TOLERANCE_MS", async () => {
    process.env.WEBHOOK_REPLAY_TOLERANCE_MS = "10000";
    registerWebhookHandler("payment.received", jest.fn());

    const staleForCustomWindow = Math.floor((Date.now() - 15_000) / 1000).toString();
    const response = await POST(
      makeSignedRequest(
        { eventType: "payment.received", eventId: "evt_custom_tol" },
        { timestamp: staleForCustomWindow },
      ),
    );

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("REPLAY_WINDOW_EXCEEDED");
  });

  it("accepts a signature made with the previous secret during rotation overlap and rejects it after expiry", async () => {
    const baseNow = Date.now();
    const dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(baseNow);

    try {
      const oldSecret = "previous-webhook-secret-32-chars-minimum-01";
      const newSecret = "rotated-webhook-secret-32-chars-minimum-02";
      resetWebhookSecretStore(oldSecret);

      webhookSecretStore.rotate(
        newSecret,
        new Request("https://streampay.test/api/webhooks/rotate", { method: "POST" }),
      );

      const handler = jest.fn();
      registerWebhookHandler("payment.received", handler);

      // Within 24h overlap window: old secret is accepted
      const overlapResponse = await POST(
        makeSignedRequest(
          { eventType: "payment.received", eventId: "evt_overlap_ok" },
          { secret: oldSecret },
        ),
      );
      expect(overlapResponse.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);

      // Advance past 24h overlap window: old secret is rejected
      dateNowSpy.mockReturnValue(baseNow + 24 * 60 * 60 * 1000 + 1_000);

      const expiredResponse = await POST(
        makeSignedRequest(
          { eventType: "payment.received", eventId: "evt_overlap_expired" },
          { secret: oldSecret },
        ),
      );
      expect(expiredResponse.status).toBe(401);
      const expiredData = await expiredResponse.json();
      expect(expiredData.error.code).toBe("INVALID_SIGNATURE");
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("deduplicates repeated deliveries of the same eventId", async () => {
    const handler = jest.fn();
    registerWebhookHandler("payment.received", handler);

    const payload = { eventType: "payment.received", eventId: "evt_dup_1" };

    const first = await POST(makeSignedRequest(payload));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ success: true });

    const second = await POST(makeSignedRequest(payload));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      success: true,
      duplicate: true,
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handles concurrent duplicate deliveries by invoking the handler only once", async () => {
    let resolveHandler!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });

    const handler = jest.fn(async () => {
      resolveHandler();
      await new Promise((r) => setTimeout(r, 10));
    });
    registerWebhookHandler("payment.received", handler);

    const payload = { eventType: "payment.received", eventId: "evt_concurrent" };

    const [res1, res2] = await Promise.all([
      POST(makeSignedRequest(payload)),
      (async () => {
        await handlerStarted;
        return POST(makeSignedRequest(payload));
      })(),
    ]);

    const body1 = await res1.json();
    const body2 = await res2.json();

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect([body1, body2]).toContainEqual({ success: true });
    expect([body1, body2]).toContainEqual({ success: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and unmarks eventId when a handler throws so the sender can retry", async () => {
    let attempts = 0;
    const handler = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient failure");
      }
    });
    registerWebhookHandler("payment.received", handler);

    const payload = { eventType: "payment.received", eventId: "evt_retry_1" };

    const first = await POST(makeSignedRequest(payload));
    expect(first.status).toBe(500);

    const retry = await POST(makeSignedRequest(payload));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ success: true });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when request JSON is invalid", async () => {
    const response = await POST(makeRequest(null, { shouldThrow: true }));

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
    const response = await POST(
      makeRequest({ eventType: "payment.received", unexpected: true }),
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
    expect(data.error.message).toBe("Unknown fields are not allowed.");
  });
});
