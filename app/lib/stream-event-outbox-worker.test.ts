import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StreamEventOutboxWorker } from './worker';
import { StreamEventOutbox, type StreamEventOutboxEntry } from './stream-event-outbox';

const vi = jest;

describe('StreamEventOutboxWorker', () => {
  let outbox: StreamEventOutbox;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    outbox = new StreamEventOutbox();
  });

  it('drains pending events FIFO and marks them published', async () => {
    const published: string[] = [];
    const worker = new StreamEventOutboxWorker({
      outbox,
      publish: (entry) => {
        published.push(entry.id);
      },
    });

    outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });
    outbox.enqueue({ eventType: 'settle.finished', streamId: 's2', payload: 2, id: 'b' });

    const result = await worker.drainOnce();

    expect(published).toEqual(['a', 'b']);
    expect(result.published).toBe(2);
    expect(outbox.get('a')?.status).toBe('published');
    expect(outbox.get('b')?.status).toBe('published');
  });

  it('does not lose an event when the publisher throws (stays retryable)', async () => {
    const worker = new StreamEventOutboxWorker({
      outbox,
      publish: () => {
        throw new Error('publish failed');
      },
    });

    outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a', maxAttempts: 3 });

    const result = await worker.drainOnce();

    expect(result.published).toBe(0);
    expect(result.retried).toBe(1);
    const entry = outbox.get('a');
    expect(entry?.status).toBe('failed'); // not published, not dropped
    expect(entry?.lastError).toBe('publish failed');
  });

  it('delivers at-least-once: a transient failure is redelivered on the next drain', async () => {
    let attempts = 0;
    const delivered: string[] = [];
    const worker = new StreamEventOutboxWorker({
      // 0ms visibility timeout so the failed entry is immediately reclaimable.
      outbox: new StreamEventOutbox({ visibilityTimeoutMs: 0 }),
      publish: (entry: StreamEventOutboxEntry) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        delivered.push(entry.id);
      },
    });
    // enqueue into the worker's own outbox instance
    (worker as unknown as { outbox: StreamEventOutbox }).outbox.enqueue({
      eventType: 'stream.updated',
      streamId: 's1',
      payload: 1,
      id: 'a',
    });

    const first = await worker.drainOnce();
    expect(first.retried).toBe(1);
    expect(delivered).toEqual([]);

    // Backoff for attempt 1 is ~1s; advance time so the retry is due.
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 5_000);
    const second = await worker.drainOnce();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(second.published).toBe(1);
    expect(delivered).toEqual(['a']);
    expect(attempts).toBe(2);
  });

  it('moves a permanently failing event to the DLQ', async () => {
    const worker = new StreamEventOutboxWorker({
      outbox: new StreamEventOutbox({ visibilityTimeoutMs: 0 }),
      publish: () => {
        throw new Error('always fails');
      },
    });
    const own = (worker as unknown as { outbox: StreamEventOutbox }).outbox;
    own.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a', maxAttempts: 3 });

    const realNow = Date.now;
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);

    // Drain repeatedly, advancing past each backoff window.
    for (let i = 0; i < 3; i++) {
      await worker.drainOnce();
      offset += 120_000; // beyond max backoff
    }

    expect(own.get('a')?.status).toBe('dead');
    expect(own.getDeadLetters()).toHaveLength(1);
  });

  it('drainAll stops once the queue is empty', async () => {
    const worker = new StreamEventOutboxWorker({ outbox, publish: () => {} });
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's2', payload: 2, id: 'b' });

    const result = await worker.drainAll();

    expect(result.published).toBe(2);
    expect(outbox.getStatistics().pending).toBe(0);
  });
});
