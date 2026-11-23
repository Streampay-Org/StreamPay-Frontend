/**
 * Tests for WebhookDeliveryStore.getDeliveriesPage — cursor pagination over
 * (createdAt, deliveryId) for stable ordering.
 */

import { WebhookDeliveryStore } from './webhook-delivery-store';
import { encodeCompositeCursor } from './db';
import type { WebhookEndpoint, WebhookEvent } from './webhook-delivery';

const endpoint: WebhookEndpoint = {
  id: 'endpoint-1',
  url: 'https://example.com/hook',
  maxRetries: 3,
};

function makeEvent(id: string): WebhookEvent {
  return {
    id: `event-${id}`,
    eventType: 'stream.created',
    streamId: 'stream-1',
    data: {},
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

/** Creates a delivery with a fixed createdAt by freezing Date around the call. */
function createDeliveryAt(store: WebhookDeliveryStore, deliveryId: string, createdAt: string) {
  const realDate = Date;
  const fixed = new realDate(createdAt);
  const dateSpy = jest.spyOn(global, 'Date').mockImplementation(() => fixed);
  try {
    return store.createDelivery(deliveryId, endpoint, makeEvent(deliveryId));
  } finally {
    dateSpy.mockRestore();
  }
}

describe('WebhookDeliveryStore.getDeliveriesPage', () => {
  let store: WebhookDeliveryStore;

  beforeEach(() => {
    store = new WebhookDeliveryStore();
  });

  it('returns an empty page when there are no deliveries', () => {
    const page = store.getDeliveriesPage({ limit: 20 });

    expect(page.data).toEqual([]);
    expect(page.hasNext).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(0);
  });

  it('orders deliveries by createdAt descending (newest first)', () => {
    createDeliveryAt(store, 'd1', '2026-01-01T00:00:00.000Z');
    createDeliveryAt(store, 'd2', '2026-01-03T00:00:00.000Z');
    createDeliveryAt(store, 'd3', '2026-01-02T00:00:00.000Z');

    const page = store.getDeliveriesPage({ limit: 20 });

    expect(page.data.map((d) => d.deliveryId)).toEqual(['d2', 'd3', 'd1']);
    expect(page.total).toBe(3);
  });

  it('breaks ties on deliveryId (descending) when createdAt collides', () => {
    createDeliveryAt(store, 'a', '2026-01-01T00:00:00.000Z');
    createDeliveryAt(store, 'c', '2026-01-01T00:00:00.000Z');
    createDeliveryAt(store, 'b', '2026-01-01T00:00:00.000Z');

    const page = store.getDeliveriesPage({ limit: 20 });

    expect(page.data.map((d) => d.deliveryId)).toEqual(['c', 'b', 'a']);
  });

  it('paginates across pages using nextCursor with no gaps or duplicates', () => {
    for (let i = 1; i <= 5; i += 1) {
      createDeliveryAt(store, `d${i}`, `2026-01-0${i}T00:00:00.000Z`);
    }

    const page1 = store.getDeliveriesPage({ limit: 2 });
    expect(page1.data.map((d) => d.deliveryId)).toEqual(['d5', 'd4']);
    expect(page1.hasNext).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = store.getDeliveriesPage({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.data.map((d) => d.deliveryId)).toEqual(['d3', 'd2']);
    expect(page2.hasNext).toBe(true);

    const page3 = store.getDeliveriesPage({ limit: 2, cursor: page2.nextCursor! });
    expect(page3.data.map((d) => d.deliveryId)).toEqual(['d1']);
    expect(page3.hasNext).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });

  it('returns an empty page for a malformed cursor instead of throwing', () => {
    createDeliveryAt(store, 'd1', '2026-01-01T00:00:00.000Z');

    expect(() => store.getDeliveriesPage({ limit: 20, cursor: 'not-a-real-cursor' })).not.toThrow();
    const page = store.getDeliveriesPage({ limit: 20, cursor: 'not-a-real-cursor' });

    expect(page.data).toEqual([]);
    expect(page.hasNext).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('produces a cursor that round-trips via encodeCompositeCursor', () => {
    createDeliveryAt(store, 'd1', '2026-01-01T00:00:00.000Z');
    createDeliveryAt(store, 'd2', '2026-01-02T00:00:00.000Z');

    // limit=1 returns just the newest delivery (d2); the cursor points at
    // its own position so the next page resumes strictly before it.
    const page = store.getDeliveriesPage({ limit: 1 });
    expect(page.data.map((d) => d.deliveryId)).toEqual(['d2']);
    expect(page.nextCursor).toBe(encodeCompositeCursor('2026-01-02T00:00:00.000Z', 'd2'));
  });
});

describe('WebhookDeliveryStore.getDeliveryHealthStats', () => {
  let store: WebhookDeliveryStore;
  const STALE_AFTER_MS = 10_000;
  const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

  beforeEach(() => {
    store = new WebhookDeliveryStore();
  });

  it('returns all zeros for an empty store', () => {
    expect(store.getDeliveryHealthStats(BASE_TIME, STALE_AFTER_MS)).toEqual({
      total: 0,
      delivered: 0,
      failed: 0,
      pending: 0,
      dlq: 0,
      stale: 0,
    });
  });

  it('counts delivered, failed, pending, and dlq records accurately', () => {
    createDeliveryAt(store, 'd-delivered', '2026-01-01T00:00:00.000Z');
    store.markDelivered('d-delivered');

    const failedRecord = createDeliveryAt(store, 'd-failed', '2026-01-01T00:00:00.000Z');
    failedRecord.status = 'failed';

    createDeliveryAt(store, 'd-pending', '2026-01-01T00:00:00.000Z');

    createDeliveryAt(store, 'd-dlq', '2026-01-01T00:00:00.000Z');
    store.recordAttempt('d-dlq', {
      attemptNumber: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      statusCode: 500,
    });
    store.moveToDLQ('d-dlq', 'max retries exceeded');

    expect(store.getDeliveryHealthStats(BASE_TIME + 1_000, STALE_AFTER_MS)).toEqual({
      total: 4,
      delivered: 1,
      failed: 1,
      pending: 1,
      dlq: 1,
      stale: 0,
    });
  });

  it('evaluates stale boundary using createdAt when there are no attempts (1ms before, exact, 1ms after)', () => {
    createDeliveryAt(store, 'd-pending', '2026-01-01T00:00:00.000Z');

    // 1 ms before threshold -> not stale
    expect(store.getDeliveryHealthStats(BASE_TIME + STALE_AFTER_MS - 1, STALE_AFTER_MS).stale).toBe(0);

    // Exactly at threshold -> not stale (must be strictly older than staleAfterMs)
    expect(store.getDeliveryHealthStats(BASE_TIME + STALE_AFTER_MS, STALE_AFTER_MS).stale).toBe(0);

    // 1 ms after threshold -> stale
    expect(store.getDeliveryHealthStats(BASE_TIME + STALE_AFTER_MS + 1, STALE_AFTER_MS).stale).toBe(1);
  });

  it('uses the last attempt timestamp rather than createdAt when attempts exist', () => {
    createDeliveryAt(store, 'd-retried', '2026-01-01T00:00:00.000Z');
    store.recordAttempt('d-retried', {
      attemptNumber: 1,
      timestamp: new Date(BASE_TIME + 5_000).toISOString(),
      statusCode: 503,
    });
    store.recordAttempt('d-retried', {
      attemptNumber: 2,
      timestamp: new Date(BASE_TIME + 20_000).toISOString(),
      statusCode: 503,
    });

    // At BASE_TIME + 30_000: createdAt is 30s old, but last attempt is exactly 10s old -> not stale
    expect(store.getDeliveryHealthStats(BASE_TIME + 30_000, STALE_AFTER_MS).stale).toBe(0);

    // 1 ms later: last attempt is 10_001ms old -> stale
    expect(store.getDeliveryHealthStats(BASE_TIME + 30_001, STALE_AFTER_MS).stale).toBe(1);
  });

  it('never counts non-pending deliveries as stale regardless of age', () => {
    createDeliveryAt(store, 'd-delivered', '2026-01-01T00:00:00.000Z');
    store.markDelivered('d-delivered');

    const failedRecord = createDeliveryAt(store, 'd-failed', '2026-01-01T00:00:00.000Z');
    failedRecord.status = 'failed';

    createDeliveryAt(store, 'd-dlq', '2026-01-01T00:00:00.000Z');
    store.recordAttempt('d-dlq', {
      attemptNumber: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      statusCode: 500,
    });
    store.moveToDLQ('d-dlq', 'terminal error');

    const farFuture = BASE_TIME + STALE_AFTER_MS * 100;
    const stats = store.getDeliveryHealthStats(new Date(farFuture), STALE_AFTER_MS);
    expect(stats.stale).toBe(0);
    expect(stats.total).toBe(3);
  });
});
