import {
  WebhookHandlerRegistry,
  clearWebhookHandlers,
  dispatchWebhook,
  registerWebhookHandler,
  unregisterWebhookHandler,
} from "./webhook-handlers";
import type { WebhookPayload } from "@/src/validators/webhooks";

describe("WebhookHandlerRegistry", () => {
  afterEach(() => {
    clearWebhookHandlers();
  });

  it("dispatches a registered handler and returns handled: true", async () => {
    const registry = new WebhookHandlerRegistry();
    const received: WebhookPayload[] = [];

    registry.register("payment.received", async (payload) => {
      received.push(payload);
    });

    const payload: WebhookPayload = {
      eventType: "payment.received",
      eventId: "evt_100",
      data: { amount: "50" },
    };

    const result = await registry.dispatch(payload);
    expect(result).toEqual({ handled: true, eventType: "payment.received" });
    expect(received).toEqual([payload]);
  });

  it("returns handled: false for unknown event types", async () => {
    const registry = new WebhookHandlerRegistry();
    const result = await registry.dispatch({
      eventType: "unknown.event",
      eventId: "evt_101",
    });

    expect(result).toEqual({ handled: false, eventType: "unknown.event" });
  });

  it("propagates handler exceptions", async () => {
    const registry = new WebhookHandlerRegistry();
    registry.register("stream.failed", async () => {
      throw new Error("downstream failure");
    });

    await expect(
      registry.dispatch({ eventType: "stream.failed", eventId: "evt_102" }),
    ).rejects.toThrow("downstream failure");
  });

  it("supports unregistering via returned disposer and unregister()", () => {
    const handler = jest.fn();
    const dispose = registerWebhookHandler("stream.created", handler);

    expect(unregisterWebhookHandler("nonexistent")).toBe(false);
    dispose();

    return expect(
      dispatchWebhook({ eventType: "stream.created", eventId: "evt_103" }),
    ).resolves.toEqual({ handled: false, eventType: "stream.created" });
  });

  it("rejects blank eventType on registration", () => {
    const registry = new WebhookHandlerRegistry();
    expect(() => registry.register("   ", jest.fn())).toThrow(
      "eventType must be a non-empty string",
    );
  });
});
