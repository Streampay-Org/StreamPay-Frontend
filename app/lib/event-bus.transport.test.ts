/**
 * @jest-environment node
 */

import { EventEmitter } from "events";
import { ConfigValidationError, validateEventBusConfig } from "@/app/lib/config";
import { StreamEventBus, type StreamUpdatedPayload } from "@/app/lib/event-bus";
import {
  InMemoryTransport,
  serializeEventPayload,
} from "@/app/lib/event-bus-transport";
import {
  REDIS_EVENT_CHANNEL_PREFIX,
  RedisTransport,
  type RedisPubSubClient,
} from "@/app/lib/event-bus-redis";

// ---------------------------------------------------------------------------
// In-memory fake Redis Pub/Sub broker for deterministic multi-instance tests
// ---------------------------------------------------------------------------

class FakeRedisBroker {
  private readonly channels = new Map<string, Set<FakeRedisClient>>();
  public readonly published: Array<{ channel: string; message: string }> = [];
  public failPublish = false;

  subscribe(channel: string, client: FakeRedisClient): void {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(client);
  }

  unsubscribe(channel: string, client: FakeRedisClient): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    subs.delete(client);
    if (subs.size === 0) {
      this.channels.delete(channel);
    }
  }

  hasSubscription(channel: string, client?: FakeRedisClient): boolean {
    const subs = this.channels.get(channel);
    if (!subs) return false;
    return client ? subs.has(client) : subs.size > 0;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.failPublish) {
      throw new Error("ECONNREFUSED: Redis unavailable");
    }
    this.published.push({ channel, message });
    const subs = this.channels.get(channel);
    if (!subs) return 0;
    let count = 0;
    for (const client of Array.from(subs)) {
      count += 1;
      client.deliver(channel, message);
    }
    return count;
  }
}

class FakeRedisClient extends EventEmitter implements RedisPubSubClient {
  public closed = false;
  public quitCalled = false;
  public readonly subscribedChannels = new Set<string>();

  constructor(private readonly broker: FakeRedisBroker) {
    super();
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.broker.publish(channel, message);
  }

  async subscribe(channel: string): Promise<number> {
    this.subscribedChannels.add(channel);
    this.broker.subscribe(channel, this);
    return this.subscribedChannels.size;
  }

  async unsubscribe(channel: string): Promise<number> {
    this.subscribedChannels.delete(channel);
    this.broker.unsubscribe(channel, this);
    return this.subscribedChannels.size;
  }

  deliver(channel: string, message: string): void {
    if (!this.closed) {
      this.emit("message", channel, message);
    }
  }

  async quit(): Promise<"OK"> {
    this.quitCalled = true;
    this.closed = true;
    for (const ch of Array.from(this.subscribedChannels)) {
      this.broker.unsubscribe(ch, this);
    }
    this.subscribedChannels.clear();
    return "OK";
  }

  disconnect(): void {
    this.closed = true;
  }
}

function makeStreamPayload(id = "stream-1"): StreamUpdatedPayload {
  return {
    id,
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    token: "USDC",
    ratePerSecond: "0.01",
    totalAmount: "100",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  } as StreamUpdatedPayload;
}

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe("validateEventBusConfig", () => {
  it("defaults to memory when EVENT_BUS_TRANSPORT is unset", () => {
    expect(validateEventBusConfig(undefined, undefined)).toEqual({
      transport: "memory",
    });
  });

  it("accepts memory explicitly", () => {
    expect(validateEventBusConfig("memory", undefined)).toEqual({
      transport: "memory",
    });
  });

  it("rejects unknown transport values", () => {
    expect(() => validateEventBusConfig("kafka", undefined)).toThrow(
      ConfigValidationError,
    );
  });

  it("fails fast when redis is selected without EVENT_BUS_REDIS_URL", () => {
    expect(() => validateEventBusConfig("redis", undefined)).toThrow(
      /EVENT_BUS_REDIS_URL/,
    );
  });

  it("fails fast when EVENT_BUS_REDIS_URL is malformed or uses wrong protocol", () => {
    expect(() => validateEventBusConfig("redis", "not-a-url")).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      validateEventBusConfig("redis", "http://localhost:6379"),
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it("accepts valid redis:// and rediss:// URLs", () => {
    expect(validateEventBusConfig("redis", "redis://localhost:6379")).toEqual({
      transport: "redis",
      redisUrl: "redis://localhost:6379",
    });
    expect(
      validateEventBusConfig("redis", "rediss://user:pass@redis.example.com:6380"),
    ).toEqual({
      transport: "redis",
      redisUrl: "rediss://user:pass@redis.example.com:6380",
    });
  });
});

// ---------------------------------------------------------------------------
// Payload serialization tests
// ---------------------------------------------------------------------------

describe("serializeEventPayload", () => {
  it("converts bigint values to strings safely", () => {
    const res = serializeEventPayload({ amount: BigInt("900719925474099312345") });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(JSON.parse(res.json)).toEqual({
        amount: "900719925474099312345",
      });
    }
  });

  it("drops payloads exceeding maxBytes", () => {
    const res = serializeEventPayload({ data: "x".repeat(500) }, 128);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("oversized");
    }
  });
});

// ---------------------------------------------------------------------------
// InMemoryTransport tests
// ---------------------------------------------------------------------------

describe("InMemoryTransport + StreamEventBus", () => {
  it("delivers events locally once, preserves maxListeners=100, and closes cleanly", async () => {
    const bus = new StreamEventBus({
      transport: new InMemoryTransport(),
      enableProjectionHandler: false,
    });
    expect(bus.getMaxListeners()).toBe(100);

    const received: StreamUpdatedPayload[] = [];
    const handler = (data: StreamUpdatedPayload) => received.push(data);
    bus.onStreamUpdated("s-1", handler);

    const payload = makeStreamPayload("s-1");
    bus.emitStreamUpdated("s-1", payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    bus.offStreamUpdated("s-1", handler);
    bus.emitStreamUpdated("s-1", payload);
    expect(received).toHaveLength(1);

    await bus.close();
  });
});

// ---------------------------------------------------------------------------
// RedisTransport unit & multi-instance integration tests
// ---------------------------------------------------------------------------

describe("RedisTransport + StreamEventBus (fake Redis broker)", () => {
  it("fans out events from instance A to SSE-style subscriber on instance B exactly once without duplicating on A", async () => {
    const broker = new FakeRedisBroker();
    const transportA = new RedisTransport({
      instanceId: "instance-a",
      createClient: () => new FakeRedisClient(broker),
    });
    const transportB = new RedisTransport({
      instanceId: "instance-b",
      createClient: () => new FakeRedisClient(broker),
    });

    const busA = new StreamEventBus({
      transport: transportA,
      enableProjectionHandler: false,
    });
    const busB = new StreamEventBus({
      transport: transportB,
      enableProjectionHandler: false,
    });

    const receivedOnA: StreamUpdatedPayload[] = [];
    const receivedOnB: StreamUpdatedPayload[] = [];

    busA.onStreamUpdated("stream-42", (d) => receivedOnA.push(d));
    busB.onStreamUpdated("stream-42", (d) => receivedOnB.push(d));

    const payload = makeStreamPayload("stream-42");
    busA.emitStreamUpdated("stream-42", payload);

    // Allow microtasks for async publish/subscribe
    await new Promise((r) => setImmediate(r));

    expect(receivedOnA).toHaveLength(1);
    expect(receivedOnB).toHaveLength(1);
    expect(receivedOnB[0]).toEqual(payload);

    // Verify wire format: channel prefix and JSON envelope
    expect(broker.published).toHaveLength(1);
    expect(broker.published[0].channel).toBe(
      `${REDIS_EVENT_CHANNEL_PREFIX}stream:updated:stream-42`,
    );
    const envelope = JSON.parse(broker.published[0].message);
    expect(envelope).toMatchObject({
      origin: "instance-a",
      data: payload,
    });
    expect(typeof envelope.id).toBe("string");
    expect(typeof envelope.ts).toBe("number");

    await Promise.all([busA.close(), busB.close()]);
  });

  it("handles Redis outage gracefully: local delivery still works and publish error is counted", async () => {
    const broker = new FakeRedisBroker();
    broker.failPublish = true;

    const transport = new RedisTransport({
      instanceId: "instance-outage",
      createClient: () => new FakeRedisClient(broker),
    });
    const bus = new StreamEventBus({
      transport,
      enableProjectionHandler: false,
    });

    const received: StreamUpdatedPayload[] = [];
    bus.onStreamUpdated("s-outage", (d) => received.push(d));

    expect(() =>
      bus.emitStreamUpdated("s-outage", makeStreamPayload("s-outage")),
    ).not.toThrow();

    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(transport.getStats().publishErrors).toBe(1);

    await bus.close();
  });

  it("drops oversized payloads and counts them without publishing to Redis", async () => {
    const broker = new FakeRedisBroker();
    const transport = new RedisTransport({
      instanceId: "instance-size",
      maxPayloadBytes: 128,
      createClient: () => new FakeRedisClient(broker),
    });

    await transport.publish("stream:updated:big", { blob: "a".repeat(300) });

    expect(broker.published).toHaveLength(0);
    expect(transport.getStats().droppedOversized).toBe(1);

    await transport.close();
  });

  it("ignores malformed Redis messages and counts them", async () => {
    const broker = new FakeRedisBroker();
    let subClient!: FakeRedisClient;
    const transport = new RedisTransport({
      instanceId: "instance-malformed",
      createClient: (role) => {
        const c = new FakeRedisClient(broker);
        if (role === "subscriber") subClient = c;
        return c;
      },
    });

    const handler = jest.fn();
    await transport.subscribe("stream:updated:s1", handler);

    // Malformed JSON
    subClient.deliver(`${REDIS_EVENT_CHANNEL_PREFIX}stream:updated:s1`, "{not-json");
    // Missing origin/data
    subClient.deliver(
      `${REDIS_EVENT_CHANNEL_PREFIX}stream:updated:s1`,
      JSON.stringify({ foo: "bar" }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(transport.getStats().malformedMessages).toBe(2);

    await transport.close();
  });

  it("tracks reconnect events and cleans up Redis channel subscriptions on unsubscribe", async () => {
    const broker = new FakeRedisBroker();
    let pubClient!: FakeRedisClient;
    let subClient!: FakeRedisClient;

    const transport = new RedisTransport({
      instanceId: "instance-lifecycle",
      createClient: (role) => {
        const c = new FakeRedisClient(broker);
        if (role === "publisher") pubClient = c;
        if (role === "subscriber") subClient = c;
        return c;
      },
    });

    const bus = new StreamEventBus({
      transport,
      enableProjectionHandler: false,
    });

    const handler = jest.fn();
    bus.onStreamUpdated("s-unsub", handler);
    await new Promise((r) => setImmediate(r));

    const redisChannel = `${REDIS_EVENT_CHANNEL_PREFIX}stream:updated:s-unsub`;
    expect(broker.hasSubscription(redisChannel, subClient)).toBe(true);

    // Simulate reconnect event
    subClient.emit("reconnecting", 200);
    expect(transport.getStats().reconnects).toBe(1);

    // Unsubscribe cleans up Redis channel subscription
    bus.offStreamUpdated("s-unsub", handler);
    await new Promise((r) => setImmediate(r));
    expect(broker.hasSubscription(redisChannel, subClient)).toBe(false);

    // Close quits both connections
    await bus.close();
    expect(pubClient.quitCalled).toBe(true);
    expect(subClient.quitCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real Redis integration test (skipped unless REDIS_URL is set)
// ---------------------------------------------------------------------------

const describeRealRedis = process.env.REDIS_URL ? describe : describe.skip;

describeRealRedis("RedisTransport real Redis integration", () => {
  it("fans out events across two bus instances over real Redis", async () => {
    const redisUrl = process.env.REDIS_URL as string;
    const transportA = new RedisTransport({ redisUrl, instanceId: "real-a" });
    const transportB = new RedisTransport({ redisUrl, instanceId: "real-b" });

    const busA = new StreamEventBus({
      transport: transportA,
      enableProjectionHandler: false,
    });
    const busB = new StreamEventBus({
      transport: transportB,
      enableProjectionHandler: false,
    });

    try {
      const received = new Promise<StreamUpdatedPayload>((resolve) => {
        busB.onStreamUpdated("real-stream-1", (data) => resolve(data));
      });

      // Give Redis SUBSCRIBE a brief moment to register
      await new Promise((r) => setTimeout(r, 150));

      const payload = makeStreamPayload("real-stream-1");
      busA.emitStreamUpdated("real-stream-1", payload);

      const result = await received;
      expect(result).toEqual(payload);
    } finally {
      await Promise.all([busA.close(), busB.close()]);
    }
  });
});
