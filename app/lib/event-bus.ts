import { EventEmitter } from "events";
import {
  streamEventOutbox,
  type EnqueueInput,
  type StreamEventOutboxEntry,
} from "./stream-event-outbox";

/**
 * Server-side event bus for StreamPay events.
 * This acts as the central hub for emitting and subscribing to live updates.
 *
 * In a distributed production environment, this would be replaced by
 * Redis Pub/Sub or a similar message broker.
 *
 * Two publish paths are supported:
 * - The legacy *inline* path (`emitStreamUpdated` / `emitSettleFinished`) emits
 *   straight to subscribers. It is fire-and-forget: if the process crashes
 *   right after a state change, the event is lost.
 * - The *transactional* path (`enqueueStreamUpdated` / `enqueueSettleFinished`)
 *   durably appends the event to the {@link streamEventOutbox} in the same step
 *   as the state mutation. The outbox worker later drains it and replays it via
 *   {@link StreamEventBus.publishFromOutbox}, giving at-least-once delivery with
 *   no loss on crash. New code should prefer the transactional path.
 */
class StreamEventBus extends EventEmitter {
  private static instance: StreamEventBus;

  private constructor() {
    super();
    // Increase max listeners to avoid warnings during development
    this.setMaxListeners(100);
  }

  public static getInstance(): StreamEventBus {
    if (!StreamEventBus.instance) {
      StreamEventBus.instance = new StreamEventBus();
    }
    return StreamEventBus.instance;
  }

  /**
   * Emit a stream update event
   */
  emitStreamUpdated(streamId: string, data: any) {
    this.emit(`stream:updated:${streamId}`, data);
  }

  /**
   * Emit a settlement finished event
   */
  emitSettleFinished(streamId: string, data: any) {
    this.emit(`settle:finished:${streamId}`, data);
  }

  /**
   * Transactionally enqueue a stream update for durable, at-least-once
   * delivery. Call this in the same transaction as the state change; the
   * outbox worker drains it and emits to live subscribers.
   */
  enqueueStreamUpdated(
    streamId: string,
    data: unknown,
    opts: Pick<EnqueueInput, "id" | "maxAttempts"> = {},
  ): StreamEventOutboxEntry {
    return streamEventOutbox.enqueue({
      eventType: "stream.updated",
      streamId,
      payload: data,
      ...opts,
    });
  }

  /**
   * Transactionally enqueue a settlement-finished event. See
   * {@link enqueueStreamUpdated}.
   */
  enqueueSettleFinished(
    streamId: string,
    data: unknown,
    opts: Pick<EnqueueInput, "id" | "maxAttempts"> = {},
  ): StreamEventOutboxEntry {
    return streamEventOutbox.enqueue({
      eventType: "settle.finished",
      streamId,
      payload: data,
      ...opts,
    });
  }

  /**
   * Replay a drained outbox entry to live subscribers. Invoked by the outbox
   * worker — not intended for direct use by producers.
   */
  publishFromOutbox(entry: StreamEventOutboxEntry): void {
    switch (entry.eventType) {
      case "stream.updated":
        this.emit(`stream:updated:${entry.streamId}`, entry.payload);
        break;
      case "settle.finished":
        this.emit(`settle:finished:${entry.streamId}`, entry.payload);
        break;
    }
  }
}

export const eventBus = StreamEventBus.getInstance();
