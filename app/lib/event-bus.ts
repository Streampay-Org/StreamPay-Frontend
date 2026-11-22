import { EventEmitter } from "events";
import { getStore } from "@/app/lib/db";
import { activityEventToTimelineEntry } from "@/app/lib/repositories/activity-timeline";
import type { ActivityEvent, Stream } from "@/app/types/openapi";

export type StreamUpdatedPayload = Omit<
  Stream,
  "email" | "label" | "memo" | "partnerId"
>;

export type SettleFinishedPayload = Omit<
  Stream,
  "email" | "label" | "memo" | "partnerId"
>;

export interface StreamEventMap {
  [event: `stream:updated:${string}`]: [data: StreamUpdatedPayload];
  [event: `settle:finished:${string}`]: [data: SettleFinishedPayload];
  "activity:new": [event: ActivityEvent];
}

/**
 * Server-side event bus for StreamPay events.
 * This acts as the central hub for emitting and subscribing to live updates.
 * 
 * In a distributed production environment, this would be replaced by 
 * Redis Pub/Sub or a similar message broker.
 */
class StreamEventBus extends EventEmitter {
  private static instance: StreamEventBus;

  private constructor() {
    super();
    this.setMaxListeners(100);
    this.setupProjectionHandler();
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
  emitStreamUpdated(streamId: string, data: StreamUpdatedPayload) {
    this.emit(`stream:updated:${streamId}`, data);
  }

  /**
   * Subscribe to stream update events for a specific stream.
   */
  onStreamUpdated(streamId: string, handler: (data: StreamUpdatedPayload) => void) {
    this.on(`stream:updated:${streamId}`, handler);
  }

  /**
   * Unsubscribe from stream update events for a specific stream.
   */
  offStreamUpdated(streamId: string, handler: (data: StreamUpdatedPayload) => void) {
    this.off(`stream:updated:${streamId}`, handler);
  }

  /**
   * Emit a settlement finished event
   */
  emitSettleFinished(streamId: string, data: SettleFinishedPayload) {
    this.emit(`settle:finished:${streamId}`, data);
  }

  /**
   * Subscribe to settlement finished events for a specific stream.
   */
  onSettleFinished(streamId: string, handler: (data: SettleFinishedPayload) => void) {
    this.on(`settle:finished:${streamId}`, handler);
  }

  /**
   * Unsubscribe from settlement finished events for a specific stream.
   */
  offSettleFinished(streamId: string, handler: (data: SettleFinishedPayload) => void) {
    this.off(`settle:finished:${streamId}`, handler);
  }

  /**
   * Emit a raw activity event to be projected onto the timeline.
   */
  emitActivityEvent(event: ActivityEvent) {
    this.emit("activity:new", event);
  }

  /**
   * Subscribe to raw activity events.
   */
  onActivityEvent(handler: (event: ActivityEvent) => void) {
    this.on("activity:new", handler);
  }

  /**
   * Set up the internal projection handler that writes to the
   * denormalized activity_timeline store whenever a new event
   * is emitted.
   */
  private setupProjectionHandler() {
    this.onActivityEvent((event) => {
      try {
        const store = getStore();
        const entry = activityEventToTimelineEntry(event);
        store.activityTimeline.append(entry);
      } catch {
        // If the store is not available (e.g. postgres adapter not wired),
        // silently skip. The projection is best-effort for the in-memory store.
      }
    });
  }
}

export const eventBus = StreamEventBus.getInstance();
