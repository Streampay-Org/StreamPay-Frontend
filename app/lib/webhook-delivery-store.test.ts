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
  jest.spyOn(global, 'Date').mockImplementation(() => fixed as unknown as Date);
  try {
    return store.createDelivery(deliveryId, endpoint, makeEvent(deliveryId));
  } finally {
    (global.Date as unknown as jest.SpyInstance).mockRestore();
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
