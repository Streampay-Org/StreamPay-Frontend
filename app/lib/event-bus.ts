import { EventEmitter } from "events";
import { getStore } from "@/app/lib/db";
import { validateEventBusConfig } from "@/app/lib/config";
import { logger } from "@/app/lib/logger";
import { activityEventToTimelineEntry } from "@/app/lib/repositories/activity-timeline";
import {
  InMemoryTransport,
  type EventBusMessageHandler,
  type EventBusTransport,
} from "@/app/lib/event-bus-transport";
import { RedisTransport } from "@/app/lib/event-bus-redis";
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

export interface StreamEventBusOptions {
  transport?: EventBusTransport;
  /** Disable the internal activity timeline projection handler (useful in isolated tests). */
  enableProjectionHandler?: boolean;
}

/**
 * Create the default transport from environment configuration.
 * Defaults to `InMemoryTransport` when `EVENT_BUS_TRANSPORT` is unset or `memory`.
 * Fails fast with `ConfigValidationError` when `EVENT_BUS_TRANSPORT=redis`
 * without a valid `EVENT_BUS_REDIS_URL`.
 */
export function createEventBusTransportFromEnv(): EventBusTransport {
  const { transport, redisUrl } = validateEventBusConfig(
    process.env.EVENT_BUS_TRANSPORT,
    process.env.EVENT_BUS_REDIS_URL,
  );

  if (transport === "redis") {
    return new RedisTransport({ redisUrl });
  }

  return new InMemoryTransport();
}

/**
 * Server-side event bus for StreamPay events.
 * Acts as the central hub for emitting and subscribing to live updates.
 *
 * Emits synchronously to local in-process listeners and fans events out across
 * server instances through a pluggable {@link EventBusTransport} (in-memory by
 * default, or Redis Pub/Sub when `EVENT_BUS_TRANSPORT=redis`).
 */
export class StreamEventBus extends EventEmitter {
  private static instance: StreamEventBus;
  private readonly transport: EventBusTransport;
  private readonly transportHandlers = new Map<string, EventBusMessageHandler>();

  constructor(options: StreamEventBusOptions = {}) {
    super();
    this.setMaxListeners(100);
    this.transport = options.transport ?? createEventBusTransportFromEnv();

    if (options.enableProjectionHandler !== false) {
      this.setupProjectionHandler();
    }
  }

  public static getInstance(): StreamEventBus {
    if (!StreamEventBus.instance) {
      StreamEventBus.instance = new StreamEventBus();
    }
    return StreamEventBus.instance;
  }

  private ensureTransportSubscription(eventName: string | symbol): void {
    if (typeof eventName !== "string") return;
    if (this.transportHandlers.has(eventName)) return;

    const handler: EventBusMessageHandler = (payload: unknown) => {
      // Re-emit remote messages locally without re-publishing to the transport.
      super.emit(eventName, payload);
    };

    this.transportHandlers.set(eventName, handler);
    try {
      const result = this.transport.subscribe(eventName, handler);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          logger.error("Event bus transport subscribe failed", {
            channel: eventName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error("Event bus transport subscribe threw", {
        channel: eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private cleanupTransportSubscription(eventName: string | symbol): void {
    if (typeof eventName !== "string") return;
    if (this.listenerCount(eventName) > 0) return;

    const handler = this.transportHandlers.get(eventName);
    if (!handler) return;

    this.transportHandlers.delete(eventName);
    try {
      const result = this.transport.unsubscribe(eventName, handler);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          logger.error("Event bus transport unsubscribe failed", {
            channel: eventName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error("Event bus transport unsubscribe threw", {
        channel: eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private publishToTransport(channel: string, payload: unknown): void {
    try {
      const result = this.transport.publish(channel, payload);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => {
          logger.error("Event bus transport publish failed", {
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error("Event bus transport publish threw", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override addListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
    this.ensureTransportSubscription(eventName);
    return super.addListener(eventName, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    this.ensureTransportSubscription(eventName);
    return super.on(eventName, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this {
    super.removeListener(eventName, listener);
    this.cleanupTransportSubscription(eventName);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    super.off(eventName, listener);
    this.cleanupTransportSubscription(eventName);
    return this;
  }

  override removeAllListeners(eventName?: string | symbol): this {
    if (eventName !== undefined) {
      super.removeAllListeners(eventName);
      this.cleanupTransportSubscription(eventName);
      return this;
    }

    const activeChannels = Array.from(this.transportHandlers.keys());
    super.removeAllListeners();
    for (const channel of activeChannels) {
      this.cleanupTransportSubscription(channel);
    }
    return this;
  }

  /**
   * Emit a stream update event locally and publish to the configured transport.
   */
  emitStreamUpdated(streamId: string, data: StreamUpdatedPayload) {
    const channel = `stream:updated:${streamId}`;
    this.emit(channel, data);
    this.publishToTransport(channel, data);
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
   * Emit a settlement finished event locally and publish to the configured transport.
   */
  emitSettleFinished(streamId: string, data: SettleFinishedPayload) {
    const channel = `settle:finished:${streamId}`;
    this.emit(channel, data);
    this.publishToTransport(channel, data);
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
   * Emit a raw activity event to be projected onto the timeline and fan out.
   */
  emitActivityEvent(event: ActivityEvent) {
    const channel = "activity:new";
    this.emit(channel, event);
    this.publishToTransport(channel, event);
  }

  /**
   * Subscribe to raw activity events.
   */
  onActivityEvent(handler: (event: ActivityEvent) => void) {
    this.on("activity:new", handler);
  }

  /**
   * Close the underlying transport and release all subscriptions.
   */
  async close(): Promise<void> {
    this.removeAllListeners();
    await this.transport.close();
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
