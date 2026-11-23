/**
 * Pluggable transport interface for StreamEventBus.
 *
 * Local in-process delivery is always performed synchronously by StreamEventBus
 * (EventEmitter). A transport fans events out to remote server instances and
 * delivers remote events back into the local bus via `subscribe`.
 */

export type EventBusMessageHandler = (payload: unknown) => void;

export interface EventBusTransport {
  /** Publish a payload to a logical channel (e.g. `stream:updated:<id>`). */
  publish(channel: string, payload: unknown): Promise<void> | void;
  /** Subscribe to remote messages on a logical channel. */
  subscribe(channel: string, handler: EventBusMessageHandler): Promise<void> | void;
  /**
   * Unsubscribe a specific handler (or all handlers if omitted) from a logical channel.
   */
  unsubscribe(channel: string, handler?: EventBusMessageHandler): Promise<void> | void;
  /** Release any underlying connections/resources. */
  close(): Promise<void>;
}

/** Default maximum serialized payload size in bytes (64 KiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export type SerializePayloadResult =
  | { ok: true; json: string; bytes: number }
  | { ok: false; reason: "oversized"; bytes: number; maxBytes: number }
  | { ok: false; reason: "unserializable"; error: unknown };

/**
 * JSON-safe serialization helper for event bus payloads.
 * - Converts `bigint` values to decimal strings so `JSON.stringify` never throws.
 * - Enforces a byte-length cap (`maxBytes`) so oversized payloads are dropped.
 */
export function serializeEventPayload(
  value: unknown,
  maxBytes: number = DEFAULT_MAX_PAYLOAD_BYTES,
): SerializePayloadResult {
  let json: string;
  try {
    const serialized = JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    if (serialized === undefined) {
      return {
        ok: false,
        reason: "unserializable",
        error: new Error("Payload serialized to undefined"),
      };
    }
    json = serialized;
  } catch (error) {
    return { ok: false, reason: "unserializable", error };
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxBytes) {
    return { ok: false, reason: "oversized", bytes, maxBytes };
  }

  return { ok: true, json, bytes };
}

/**
 * Default in-process transport.
 *
 * Because StreamEventBus already delivers events synchronously to local
 * listeners via EventEmitter, InMemoryTransport does not echo published
 * messages back to local subscribers (avoiding double delivery) and has
 * no external connections to manage.
 */
export class InMemoryTransport implements EventBusTransport {
  private readonly subscriptions = new Map<string, Set<EventBusMessageHandler>>();

  publish(_channel: string, _payload: unknown): void {
    // No-op: local delivery is handled synchronously by StreamEventBus.
  }

  subscribe(channel: string, handler: EventBusMessageHandler): void {
    let handlers = this.subscriptions.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(channel, handlers);
    }
    handlers.add(handler);
  }

  unsubscribe(channel: string, handler?: EventBusMessageHandler): void {
    if (!handler) {
      this.subscriptions.delete(channel);
      return;
    }
    const handlers = this.subscriptions.get(channel);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.subscriptions.delete(channel);
    }
  }

  async close(): Promise<void> {
    this.subscriptions.clear();
  }
}
