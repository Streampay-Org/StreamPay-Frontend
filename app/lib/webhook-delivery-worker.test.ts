import {
  WebhookDeliveryClient,
  type WebhookEndpoint,
  type WebhookEvent,
} from "./webhook-delivery";
import { webhookDeliveryStore } from "./webhook-delivery-store";
import { WebhookDeliveryWorker } from "./webhook-delivery-worker";

// Cursor pagination is outside the delivery worker's scope.
jest.mock("./db", () => ({
  decodeCompositeCursor: jest.fn(),
  encodeCompositeCursor: jest.fn(),
}));

jest.mock("../../src/metrics/registry", () => ({
  observeWebhookDelivery: jest.fn(),
}));

const deliveryId = "delivery-worker-test";
const timestamp = "2025-01-01T00:00:00.000Z";
const endpoint: WebhookEndpoint = {
  id: "endpoint-worker-test",
  url: "https://example.invalid/webhook",
  maxRetries: 3,
};
const event: WebhookEvent = {
  id: "event-worker-test",
  eventType: "stream.settled",
  streamId: "stream-worker-test",
  data: {},
  timestamp,
};

const retryableFailure = {
  success: false,
  statusCode: 503,
  error: "Service unavailable",
  shouldRetry: true,
};

function makeWorker(maxAttempts = 3) {
  const delay = jest.fn(
    (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  );
  const worker = new WebhookDeliveryWorker(
    { maxAttempts, initialDelayMs: 100, maxDelayMs: 250, backoffMultiplier: 2 },
    delay,
  );

  async function deliver() {
    const result = worker.processDelivery(endpoint, event, deliveryId);
    await jest.runAllTimersAsync();
    return result;
  }

  return { deliver, delay };
}

describe("WebhookDeliveryWorker retry policy", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(timestamp) });
    jest.spyOn(Math, "random").mockReturnValue(0.5);
    webhookDeliveryStore.clear();
  });

  afterEach(() => {
    webhookDeliveryStore.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    { bound: "lower", random: 0, expectedDelays: [[0], [0]] },
    { bound: "upper", random: 0.999, expectedDelays: [[199], [249]] },
  ])("pins the $bound jitter bound and stores all exhausted attempts", async ({
    random,
    expectedDelays,
  }) => {
    jest.mocked(Math.random).mockReturnValue(random);
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValue(retryableFailure);
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toEqual({
      success: false,
      deliveryId,
      attempts: 3,
      dlqed: true,
    });

    expect(attempt.mock.calls.map((call) => call[3])).toEqual([1, 2, 3]);
    // The uncapped delays would be 200 and 400 ms. The second is capped at 250.
    expect(delay.mock.calls).toEqual(expectedDelays);
    expect(webhookDeliveryStore.getAllDLQEntries()).toHaveLength(1);
    const [entry] = webhookDeliveryStore.getAllDLQEntries();
    expect(entry).toMatchObject({
      deliveryId,
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      eventId: event.id,
      reason: "Max attempts (3) exhausted: Service unavailable",
      allAttempts: [1, 2, 3].map((attemptNumber) => ({
        attemptNumber,
        statusCode: 503,
        error: retryableFailure.error,
        retryable: true,
      })),
    });
    expect(entry.lastAttempt).toEqual(entry.allAttempts[2]);
    expect(webhookDeliveryStore.getDelivery(deliveryId)?.status).toBe("dlq");
  });

  it("dead-letters a non-retryable 4xx response on the first attempt", async () => {
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValue({
        success: false,
        statusCode: 400,
        error: "Bad request",
        shouldRetry: false,
      });
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toEqual({
      success: false,
      deliveryId,
      attempts: 1,
      dlqed: true,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(webhookDeliveryStore.getAllDLQEntries()).toMatchObject([
      {
        deliveryId,
        reason: "Non-retryable failure on attempt 1: Bad request",
        allAttempts: [
          { attemptNumber: 1, statusCode: 400, error: "Bad request", retryable: false },
        ],
      },
    ]);
  });

  it("leaves an admin-deferred delivery pending without requesting DLQ promotion", async () => {
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValue({
        success: false,
        shouldRetry: true,
        deferred: true,
      });
    const promote = jest.spyOn(webhookDeliveryStore, "moveToDLQ");
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toEqual({
      success: false,
      deliveryId,
      attempts: 0,
      deferred: true,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(webhookDeliveryStore.getAllDLQEntries()).toEqual([]);
    expect(webhookDeliveryStore.getDelivery(deliveryId)).toMatchObject({
      status: "pending",
      attempts: [],
    });
  });

  it("marks a delivery successful when its second attempt succeeds", async () => {
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValueOnce(retryableFailure)
      .mockResolvedValueOnce({ success: true, statusCode: 200, shouldRetry: false });
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toEqual({ success: true, deliveryId, attempts: 2 });

    expect(attempt.mock.calls.map((call) => call[3])).toEqual([1, 2]);
    expect(delay.mock.calls).toEqual([[100]]);
    expect(webhookDeliveryStore.getAllDLQEntries()).toEqual([]);
    expect(webhookDeliveryStore.getDelivery(deliveryId)).toMatchObject({
      status: "delivered",
      attempts: [
        { attemptNumber: 1, statusCode: 503, retryable: true },
        { attemptNumber: 2, statusCode: 200, retryable: false },
      ],
    });
  });

  it("skips retry scheduling when there is only one possible attempt", async () => {
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValue(retryableFailure);
    const { deliver, delay } = makeWorker(1);

    await expect(deliver()).resolves.toEqual({
      success: false,
      deliveryId,
      attempts: 1,
      dlqed: true,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(webhookDeliveryStore.getAllDLQEntries()).toMatchObject([
      {
        reason: "Max attempts (1) exhausted: Service unavailable",
        allAttempts: [{ attemptNumber: 1, statusCode: 503 }],
      },
    ]);
  });

  it("requests dead-lettering without counting an attempt when the endpoint circuit is open", async () => {
    const error = "Circuit breaker open for endpoint";
    const attempt = jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValue({ success: false, error, shouldRetry: false });
    const promote = jest.spyOn(webhookDeliveryStore, "moveToDLQ");
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toEqual({
      success: false,
      deliveryId,
      attempts: 0,
      dlqed: true,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
    expect(promote).toHaveBeenCalledWith(deliveryId, error);
  });

  it("dead-letters a thrown error with the prior attempt history", async () => {
    jest
      .spyOn(WebhookDeliveryClient.prototype, "attemptDelivery")
      .mockResolvedValueOnce(retryableFailure)
      .mockRejectedValueOnce(new Error("unexpected client failure"));
    const { deliver, delay } = makeWorker();

    await expect(deliver()).resolves.toMatchObject({
      success: false,
      deliveryId,
      dlqed: true,
    });

    expect(delay.mock.calls).toEqual([[100]]);
    expect(webhookDeliveryStore.getAllDLQEntries()).toMatchObject([
      {
        deliveryId,
        reason: "Unexpected error: unexpected client failure",
        allAttempts: [{ attemptNumber: 1, statusCode: 503, retryable: true }],
      },
    ]);
  });
});
