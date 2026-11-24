import { webhookPayloadSchema } from "./webhooks";

describe("webhookPayloadSchema", () => {
  it("accepts the documented webhook payload shape", () => {
    const result = webhookPayloadSchema.safeParse({
      eventType: "payment.received",
      eventId: "evt_123",
      timestamp: "2026-07-26T12:34:56.000Z",
      source: "grantfox",
      data: {
        amount: "100",
        tags: ["grantfox", "f26"],
        nested: { ok: true, value: null },
      },
      metadata: {
        requestId: "req_123",
      },
      headers: {
        "x-source": "stellar-wave",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects blank eventType values", () => {
    const result = webhookPayloadSchema.safeParse({ eventType: "   " });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("eventType is required");
    }
  });

  it("rejects unknown top-level fields", () => {
    const result = webhookPayloadSchema.safeParse({
      eventType: "payment.received",
      extra: "nope",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("Unknown fields are not allowed.");
    }
  });

  it("rejects invalid timestamps", () => {
    const result = webhookPayloadSchema.safeParse({
      eventType: "payment.received",
      timestamp: "not-a-date",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["timestamp"]);
    }
  });
});
