import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { eventBus } from './event-bus';
import { streamEventOutbox } from './stream-event-outbox';

const vi = jest;

describe('StreamEventBus transactional path', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    streamEventOutbox.clear();
  });

  it('enqueueStreamUpdated writes a pending entry to the outbox', () => {
    const entry = eventBus.enqueueStreamUpdated('s1', { foo: 'bar' });

    expect(entry.status).toBe('pending');
    expect(entry.eventType).toBe('stream.updated');
    expect(entry.streamId).toBe('s1');
    expect(streamEventOutbox.get(entry.id)).toBeDefined();
  });

  it('enqueueSettleFinished records the settlement event type', () => {
    const entry = eventBus.enqueueSettleFinished('s2', { done: true });

    expect(entry.eventType).toBe('settle.finished');
    expect(entry.streamId).toBe('s2');
  });

  it('honours a caller-supplied id for idempotent enqueue', () => {
    const a = eventBus.enqueueStreamUpdated('s1', { v: 1 }, { id: 'dup' });
    const b = eventBus.enqueueStreamUpdated('s1', { v: 2 }, { id: 'dup' });

    expect(b).toBe(a);
    expect(streamEventOutbox.getAll()).toHaveLength(1);
  });

  it('publishFromOutbox emits the drained event to live subscribers', () => {
    const received: unknown[] = [];
    const handler = (data: unknown) => received.push(data);
    eventBus.on('stream:updated:s1', handler);

    const entry = eventBus.enqueueStreamUpdated('s1', { hello: 'world' });
    eventBus.publishFromOutbox(entry);

    eventBus.off('stream:updated:s1', handler);
    expect(received).toEqual([{ hello: 'world' }]);
  });
});
