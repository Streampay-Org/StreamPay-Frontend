/** @jest-environment node */
/**
 * Enforcement tests for the GLOBAL admin circuit breaker.
 *
 * These cover the wiring between `POST /api/admin/circuit-breaker` (control
 * plane) and the webhook dispatch path (data plane). The admin breaker is
 * distinct from the per-endpoint failure breaker in WebhookDeliveryClient —
 * see the webhook-delivery module docblock. The critical behavioural
 * difference asserted here: the admin breaker DEFERS deliveries, it does not
 * DLQ them.
 */
import { WebhookDeliveryClient, WebhookEndpoint, WebhookEvent } from "./webhook-delivery";
import { WebhookDeliveryWorker } from "./webhook-delivery-worker";
import { webhookDeliveryStore } from "./webhook-delivery-store";
import { webhookOutboxStore } from "./webhook-outbox";
import {
  setCircuitBreaker,
  isCircuitBreakerOpen,
  _resetAdminStateForTesting,
} from "./admin-guard";

const ADMIN_ADDRESS = "GADMIN_TEST_ADDRESS_12345";

/** Admin-authenticated request used to drive the breaker in tests. */
function adminRequest(): Request {
  return new Request("http://localhost/api/admin/circuit-breaker", {
    method: "POST",
    headers: { "Actor-Wallet-Address": ADMIN_ADDRESS },
  });
}

/** Trip or reset the global breaker through the real admin-guard entry point. */
function toggleBreaker(target: "indexer" | "webhook", open: boolean): void {
  const result = setCircuitBreaker(adminRequest(), target, open);
  if (!("circuitBreakers" in result)) {
    throw new Error("Failed to toggle breaker — admin auth rejected in test setup");
  }
}

const endpoint: WebhookEndpoint = {
  id: "ep-breaker-test",
  url: "https://example.test/hook",
  maxRetries: 3,
};

const event: WebhookEvent = {
  id: "evt-1",
  eventType: "stream.created",
  streamId: "stream-1",
  data: { amount: "100" },
  timestamp: new Date().toISOString(),
};

const fetchMock = jest.fn();

beforeEach(() => {
  _resetAdminStateForTesting(ADMIN_ADDRESS);
  // Both stores are module-level singletons — clear them so DLQ and outbox
  // assertions cannot be polluted by a previous test.
  webhookDeliveryStore.clear();
  webhookOutboxStore.clear();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("admin breaker → attemptDelivery", () => {
  it("does not contact the endpoint while the webhook breaker is open", async () => {
    toggleBreaker("webhook", true);
    const client = new WebhookDeliveryClient();

    const result = await client.attemptDelivery(endpoint, event, "d-1", 1);

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.shouldRetry).toBe(false);
    expect(result.error).toMatch(/admin circuit breaker/i);
    // The decisive assertion: no outbound HTTP happened at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers normally once the breaker is reset", async () => {
    toggleBreaker("webhook", true);
    toggleBreaker("webhook", false);
    fetchMock.mockResolvedValue({ status: 200, statusText: "OK" });
    const client = new WebhookDeliveryClient();

    const result = await client.attemptDelivery(endpoint, event, "d-2", 1);

    expect(result.success).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is unaffected by the indexer breaker (targets are independent)", async () => {
    toggleBreaker("indexer", true);
    fetchMock.mockResolvedValue({ status: 200, statusText: "OK" });
    const client = new WebhookDeliveryClient();

    const result = await client.attemptDelivery(endpoint, event, "d-3", 1);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not record an endpoint failure when deferring", async () => {
    toggleBreaker("webhook", true);
    const client = new WebhookDeliveryClient();

    // Defer many times — well past the per-endpoint threshold of 5.
    for (let i = 0; i < 10; i++) {
      await client.attemptDelivery(endpoint, event, `d-loop-${i}`, 1);
    }

    // The endpoint is blameless; its own breaker must stay closed so that
    // traffic resumes immediately when the admin resets the global breaker.
    expect(client.isCircuitOpen(endpoint.id)).toBe(false);
  });
});

describe("admin breaker → processDelivery", () => {
  it("defers instead of moving the delivery to the DLQ", async () => {
    toggleBreaker("webhook", true);
    const worker = new WebhookDeliveryWorker({}, () => Promise.resolve());

    const result = await worker.processDelivery(endpoint, event, "d-4");

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(true);
    expect(result.dlqed).toBeUndefined();

    // Regression guard: an operator-initiated pause must never discard events.
    const dlqIds = webhookDeliveryStore.getAllDLQEntries().map((e) => e.deliveryId);
    expect(dlqIds).not.toContain("d-4");
  });

  it("still DLQs on a genuine non-retryable endpoint failure", async () => {
    // Breaker closed — confirms the deferral path did not swallow real failures.
    fetchMock.mockResolvedValue({ status: 400, statusText: "Bad Request" });
    const worker = new WebhookDeliveryWorker({}, () => Promise.resolve());

    const result = await worker.processDelivery(endpoint, event, "d-5");

    expect(result.success).toBe(false);
    expect(result.dlqed).toBe(true);
    expect(result.deferred).toBeUndefined();
  });
});

describe("admin breaker → drainOutbox", () => {
  it("skips the drain entirely while the breaker is open", async () => {
    webhookOutboxStore.addToOutbox(endpoint, event);
    toggleBreaker("webhook", true);
    const worker = new WebhookDeliveryWorker({}, () => Promise.resolve());

    await worker.drainOutbox();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves deferred outbox entries retryable rather than failed", async () => {
    const entry = webhookOutboxStore.addToOutbox(endpoint, event);
    toggleBreaker("webhook", true);
    const worker = new WebhookDeliveryWorker({}, () => Promise.resolve());

    await worker.processOutboxEntry(entry);

    // Back to pending, not "failed" or "dlq" — it must be picked up again
    // by the next drain once the operator resets the breaker.
    const entries = webhookOutboxStore.getPendingOutboxEntries(100);
    expect(entries.map((e) => e.id)).toContain(entry.id);
  });
});

describe("isCircuitBreakerOpen", () => {
  it("reports per-target state independently", () => {
    expect(isCircuitBreakerOpen("indexer")).toBe(false);
    expect(isCircuitBreakerOpen("webhook")).toBe(false);

    toggleBreaker("indexer", true);

    expect(isCircuitBreakerOpen("indexer")).toBe(true);
    expect(isCircuitBreakerOpen("webhook")).toBe(false);
  });
});
