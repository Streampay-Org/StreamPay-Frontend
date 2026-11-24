import { randomUUID } from "crypto";
import Redis from "ioredis";
import { logger } from "@/app/lib/logger";
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  serializeEventPayload,
  type EventBusMessageHandler,
  type EventBusTransport,
} from "@/app/lib/event-bus-transport";

export const REDIS_EVENT_CHANNEL_PREFIX = "streampay:events:";

export interface RedisEventEnvelope {
  id: string;
  origin: string;
  ts: number;
  data: unknown;
}

/**
 * Minimal ioredis-compatible interface for Pub/Sub connections.
 * Allows injecting real `ioredis` instances or lightweight fakes in tests.
 */
export interface RedisPubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "reconnecting", listener: (delayMs: number) => void): unknown;
  on(event: "ready", listener: () => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface RedisTransportOptions {
  /** Redis connection URL (redis:// or rediss://). Required unless `createClient` is provided. */
  redisUrl?: string;
  /** Unique identifier for this server instance (used to suppress self-echo). */
  instanceId?: string;
  /** Channel prefix prepended to logical event bus channels. Defaults to `streampay:events:`. */
  channelPrefix?: string;
  /** Maximum serialized envelope size in bytes. Defaults to 64 KiB. */
  maxPayloadBytes?: number;
  /** Initial reconnect backoff delay in ms. Defaults to 100 ms. */
  reconnectBaseDelayMs?: number;
  /** Maximum reconnect backoff delay in ms. Defaults to 5000 ms. */
  reconnectMaxDelayMs?: number;
  /** Optional custom client factory (primarily for tests). */
  createClient?: (role: "publisher" | "subscriber") => RedisPubSubClient;
}

export interface RedisTransportStats {
  publishErrors: number;
  subscribeErrors: number;
  malformedMessages: number;
  droppedOversized: number;
  connectionErrors: number;
  reconnects: number;
}

/**
 * Redis Pub/Sub transport for StreamEventBus.
 *
 * Uses two dedicated connections (publisher + subscriber) because Redis
 * connections in subscriber mode cannot issue normal commands like PUBLISH.
 */
export class RedisTransport implements EventBusTransport {
  public readonly instanceId: string;
  private readonly channelPrefix: string;
  private readonly maxPayloadBytes: number;
  private readonly publisher: RedisPubSubClient;
  private readonly subscriber: RedisPubSubClient;
  private readonly subscriptions = new Map<string, Set<EventBusMessageHandler>>();
  private closed = false;

  private readonly stats: RedisTransportStats = {
    publishErrors: 0,
    subscribeErrors: 0,
    malformedMessages: 0,
    droppedOversized: 0,
    connectionErrors: 0,
    reconnects: 0,
  };

  private readonly onMessageBound: (fullChannel: string, rawMessage: string) => void;
  private readonly onPubErrorBound: (err: Error) => void;
  private readonly onSubErrorBound: (err: Error) => void;
  private readonly onReconnectingBound: (delayMs: number) => void;

  constructor(options: RedisTransportOptions) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.channelPrefix = options.channelPrefix ?? REDIS_EVENT_CHANNEL_PREFIX;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

    const baseDelay = options.reconnectBaseDelayMs ?? 100;
    const maxDelay = options.reconnectMaxDelayMs ?? 5000;

    const factory =
      options.createClient ??
      ((_role: "publisher" | "subscriber"): RedisPubSubClient => {
        if (!options.redisUrl) {
          throw new Error("RedisTransport requires either redisUrl or createClient");
        }
        return new Redis(options.redisUrl, {
          enableReadyCheck: true,
          maxRetriesPerRequest: 1,
          retryStrategy(times: number) {
            const delay = Math.min(baseDelay * 2 ** Math.max(0, times - 1), maxDelay);
            return delay;
          },
        }) as unknown as RedisPubSubClient;
      });

    this.publisher = factory("publisher");
    this.subscriber = factory("subscriber");

    this.onMessageBound = (fullChannel: string, rawMessage: string) => {
      this.handleMessage(fullChannel, rawMessage);
    };
    this.onPubErrorBound = (err: Error) => {
      this.stats.connectionErrors += 1;
      logger.error("Redis event bus publisher error", {
        instanceId: this.instanceId,
        error: err.message,
      });
    };
    this.onSubErrorBound = (err: Error) => {
      this.stats.connectionErrors += 1;
      logger.error("Redis event bus subscriber error", {
        instanceId: this.instanceId,
        error: err.message,
      });
    };
    this.onReconnectingBound = (delayMs: number) => {
      this.stats.reconnects += 1;
      logger.warn("Redis event bus reconnecting", {
        instanceId: this.instanceId,
        delayMs,
      });
    };

    this.subscriber.on("message", this.onMessageBound);
    this.publisher.on("error", this.onPubErrorBound);
    this.subscriber.on("error", this.onSubErrorBound);
    this.subscriber.on("reconnecting", this.onReconnectingBound);
  }

  public getStats(): Readonly<RedisTransportStats> {
    return { ...this.stats };
  }

  private toRedisChannel(channel: string): string {
    return `${this.channelPrefix}${channel}`;
  }

  private fromRedisChannel(fullChannel: string): string | null {
    if (!fullChannel.startsWith(this.channelPrefix)) {
      return null;
    }
    return fullChannel.slice(this.channelPrefix.length);
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    if (this.closed) {
      return;
    }

    const envelope: RedisEventEnvelope = {
      id: randomUUID(),
      origin: this.instanceId,
      ts: Date.now(),
      data: payload,
    };

    const serialized = serializeEventPayload(envelope, this.maxPayloadBytes);
    if (!serialized.ok) {
      if (serialized.reason === "oversized") {
        this.stats.droppedOversized += 1;
        logger.warn("Dropping oversized event bus payload", {
          channel,
          bytes: serialized.bytes,
          maxBytes: serialized.maxBytes,
          instanceId: this.instanceId,
        });
      } else {
        this.stats.publishErrors += 1;
        logger.error("Failed to serialize event bus payload", {
          channel,
          instanceId: this.instanceId,
          error: serialized.error instanceof Error ? serialized.error.message : String(serialized.error),
        });
      }
      return;
    }

    try {
      await this.publisher.publish(this.toRedisChannel(channel), serialized.json);
    } catch (err) {
      this.stats.publishErrors += 1;
      logger.error("Redis event bus publish failed", {
        channel,
        instanceId: this.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async subscribe(channel: string, handler: EventBusMessageHandler): Promise<void> {
    if (this.closed) {
      return;
    }

    let handlers = this.subscriptions.get(channel);
    const isFirst = !handlers || handlers.size === 0;
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(channel, handlers);
    }
    handlers.add(handler);

    if (isFirst) {
      try {
        await this.subscriber.subscribe(this.toRedisChannel(channel));
      } catch (err) {
        this.stats.subscribeErrors += 1;
        logger.error("Redis event bus subscribe failed", {
          channel,
          instanceId: this.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async unsubscribe(channel: string, handler?: EventBusMessageHandler): Promise<void> {
    const handlers = this.subscriptions.get(channel);
    if (!handlers) {
      return;
    }

    if (handler) {
      handlers.delete(handler);
    } else {
      handlers.clear();
    }

    if (handlers.size === 0) {
      this.subscriptions.delete(channel);
      if (!this.closed) {
        try {
          await this.subscriber.unsubscribe(this.toRedisChannel(channel));
        } catch (err) {
          this.stats.subscribeErrors += 1;
          logger.error("Redis event bus unsubscribe failed", {
            channel,
            instanceId: this.instanceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private handleMessage(fullChannel: string, rawMessage: string): void {
    if (this.closed) {
      return;
    }

    const channel = this.fromRedisChannel(fullChannel);
    if (channel === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      this.stats.malformedMessages += 1;
      logger.warn("Ignoring malformed JSON message from Redis event bus", {
        channel,
        instanceId: this.instanceId,
      });
      return;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as Partial<RedisEventEnvelope>).origin !== "string" ||
      !("data" in parsed)
    ) {
      this.stats.malformedMessages += 1;
      logger.warn("Ignoring invalid envelope from Redis event bus", {
        channel,
        instanceId: this.instanceId,
      });
      return;
    }

    const envelope = parsed as RedisEventEnvelope;
    if (envelope.origin === this.instanceId) {
      // Suppress self-echo: local listeners already received this event synchronously.
      return;
    }

    const handlers = this.subscriptions.get(channel);
    if (!handlers || handlers.size === 0) {
      return;
    }

    for (const handler of Array.from(handlers)) {
      try {
        handler(envelope.data);
      } catch (err) {
        logger.error("Error in Redis event bus subscriber handler", {
          channel,
          instanceId: this.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private detachListener(
    client: RedisPubSubClient,
    event: string,
    listener: (...args: unknown[]) => void,
  ): void {
    if (typeof client.off === "function") {
      client.off(event, listener);
    } else if (typeof client.removeListener === "function") {
      client.removeListener(event, listener);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.subscriptions.clear();

    this.detachListener(
      this.subscriber,
      "message",
      this.onMessageBound as (...args: unknown[]) => void,
    );
    this.detachListener(
      this.publisher,
      "error",
      this.onPubErrorBound as (...args: unknown[]) => void,
    );
    this.detachListener(
      this.subscriber,
      "error",
      this.onSubErrorBound as (...args: unknown[]) => void,
    );
    this.detachListener(
      this.subscriber,
      "reconnecting",
      this.onReconnectingBound as (...args: unknown[]) => void,
    );

    await Promise.all([
      this.closeClient(this.publisher),
      this.closeClient(this.subscriber),
    ]);
  }

  private async closeClient(client: RedisPubSubClient): Promise<void> {
    try {
      await client.quit();
    } catch {
      try {
        client.disconnect();
      } catch {
        // ignore disconnect errors during shutdown
      }
    }
  }
}
