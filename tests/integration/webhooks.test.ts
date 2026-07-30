import { NextRequest } from "next/server";
import { GET as getDeliveries } from "@/app/api/webhooks/deliveries/route";
import { POST as receiveDeadLetter } from "@/app/api/webhooks/dlq/route";
import { GET as getHealth } from "@/app/api/webhooks/health/route";
import { webhookDeliveryStore } from "@/app/lib/webhook-delivery-store";
import {
  appendToOutbox,
  InMemoryOutboxStore,
  setOutboxStore,
} from "@/lib/outbox";

const endpoint = {
  id: "endpoint-integration",
  url: "https://merchant.example/webhooks",
  maxRetries: 3,
};

const event = {
  id: "event-integration",
  eventType: "stream.created",
  streamId: "stream-integration",
  data: { amount: "25.00" },
  timestamp: "2026-07-24T12:00:00.000Z",
};

describe("webhook API integration", () => {
  beforeEach(() => {
    webhookDeliveryStore.clear();
    setOutboxStore(new InMemoryOutboxStore());
  });

  afterEach(() => {
    webhookDeliveryStore.clear();
    setOutboxStore(new InMemoryOutboxStore());
  });

  it("exposes queued events and delivery records through the API", async () => {
    appendToOutbox({ endpoint, event });
    webhookDeliveryStore.createDelivery(
      "delivery-integration",
      endpoint,
      event,
    );

    const response = await getDeliveries(
      new NextRequest("http://localhost/api/webhooks/deliveries?limit=10"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deliveries).toEqual([
      expect.objectContaining({
        deliveryId: "delivery-integration",
        endpointId: endpoint.id,
        eventId: event.id,
        status: "pending",
      }),
    ]);
    expect(body.outbox).toEqual(
      expect.objectContaining({
        total: 1,
        pending: 1,
        dispatched: 0,
        failed: 0,
      }),
    );
  });

  it("accepts a dead-letter event and reports webhook health", async () => {
    const deadLetterResponse = await receiveDeadLetter(
      new NextRequest("http://localhost/api/webhooks/dlq", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, event }),
      }),
    );

    expect(deadLetterResponse.status).toBe(200);
    await expect(deadLetterResponse.json()).resolves.toEqual({
      received: true,
    });

    const healthResponse = await getHealth();
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual(
      expect.objectContaining({
        status: "ok",
        checked_at: expect.any(String),
        subscriptions: expect.any(Object),
        delivery_stats: expect.any(Object),
      }),
    );
  });

  it("returns the canonical error envelope for invalid input", async () => {
    const response = await getDeliveries(
      new NextRequest("http://localhost/api/webhooks/deliveries?limit=0"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BAD_REQUEST",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
  });
});
