import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StreamEventOutbox } from './stream-event-outbox';

const vi = jest;

describe('StreamEventOutbox', () => {
  let outbox: StreamEventOutbox;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    outbox = new StreamEventOutbox();
  });

  it('appends an event as pending and assigns a monotonic sequence', () => {
    const a = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: { v: 1 } });
    const b = outbox.enqueue({ eventType: 'settle.finished', streamId: 's2', payload: { v: 2 } });

    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(0);
    expect(a.id).toContain('evt-');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('is idempotent when the same id is enqueued twice', () => {
    const first = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: { v: 1 }, id: 'fixed' });
    const second = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: { v: 99 }, id: 'fixed' });

    expect(second).toBe(first);
    expect(second.payload).toEqual({ v: 1 });
    expect(outbox.getAll()).toHaveLength(1);
  });

  it('claims claimable entries FIFO and marks them processing', () => {
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's2', payload: 2, id: 'b' });
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's3', payload: 3, id: 'c' });

    const claimed = outbox.claimBatch(2);

    expect(claimed.map((e) => e.id)).toEqual(['a', 'b']);
    expect(claimed.every((e) => e.status === 'processing')).toBe(true);
    expect(claimed.every((e) => e.lockedAt !== undefined)).toBe(true);
  });

  it('does not re-claim an in-flight (locked) processing entry', () => {
    outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });

    const first = outbox.claimBatch(10);
    const second = outbox.claimBatch(10);

    expect(first).toHaveLength(1);
    // Still locked, visibility timeout not elapsed → not claimable again.
    expect(second).toHaveLength(0);
  });

  it('reclaims a processing entry after the visibility timeout (crash recovery)', () => {
    const shortLease = new StreamEventOutbox({ visibilityTimeoutMs: 0 });
    shortLease.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });

    const first = shortLease.claimBatch(10);
    expect(first).toHaveLength(1);

    // Worker "crashed" before marking published; with a 0ms lease it is
    // immediately eligible for re-claiming — no event is lost.
    const second = shortLease.claimBatch(10);
    expect(second.map((e) => e.id)).toEqual(['a']);
  });

  it('marks an entry published and removes it from the claimable set', () => {
    const entry = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });
    outbox.claimBatch(10);

    const published = outbox.markPublished(entry.id);

    expect(published?.status).toBe('published');
    expect(published?.attempts).toBe(1);
    expect(outbox.claimBatch(10)).toHaveLength(0);
  });

  it('retries with backoff on failure while attempts remain', () => {
    const entry = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a', maxAttempts: 3 });
    outbox.claimBatch(10);

    const failed = outbox.markFailed(entry.id, 'boom');

    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe('boom');
    // Backoff schedules the next attempt in the future, so it is not yet claimable.
    expect(Date.parse(failed!.nextAttemptAt)).toBeGreaterThan(Date.now());
  });

  it('moves an entry to the DLQ (dead) once attempts are exhausted', () => {
    const entry = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a', maxAttempts: 2 });

    outbox.claimBatch(10);
    outbox.markFailed(entry.id, 'fail-1');
    const dead = outbox.markFailed(entry.id, 'fail-2');

    expect(dead?.status).toBe('dead');
    expect(dead?.attempts).toBe(2);
    expect(outbox.getDeadLetters().map((e) => e.id)).toEqual(['a']);
  });

  it('reports accurate statistics', () => {
    const a = outbox.enqueue({ eventType: 'stream.updated', streamId: 's1', payload: 1, id: 'a' });
    const b = outbox.enqueue({ eventType: 'stream.updated', streamId: 's2', payload: 2, id: 'b', maxAttempts: 1 });
    outbox.claimBatch(10);
    outbox.markPublished(a.id);
    outbox.markFailed(b.id, 'boom'); // maxAttempts 1 → dead

    const stats = outbox.getStatistics();
    expect(stats.total).toBe(2);
    expect(stats.published).toBe(1);
    expect(stats.dead).toBe(1);
  });

  it('returns undefined when updating an unknown entry', () => {
    expect(outbox.markPublished('nope')).toBeUndefined();
    expect(outbox.markFailed('nope', 'x')).toBeUndefined();
  });
});
