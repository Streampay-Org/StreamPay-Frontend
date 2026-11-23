/**
 * @jest-environment node
 *
 * Tests for RedisIdempotencyStore and the reserve/replay behaviour added to
 * `withIdempotency`.
 *
 * `fetch` is replaced with an in-process fake of the Upstash pipeline endpoint
 * so the scenarios run deterministically without network I/O.
 */

import { NextResponse } from "next/server";
import {
  IDEMPOTENCY_KEY_PREFIX,
  RedisIdempotencyStore,
} from "./idempotency-store-redis";
import { createIdempotencyStore, withIdempotency } from "./idempotency";

// ---------------------------------------------------------------------------
// Fake Redis — GET / SET (PX, NX) / DEL with lazy expiry
// ---------------------------------------------------------------------------

interface FakeEntry {
  value: string;
  expiresAt: number | null;
}

class FakeRedis {
  readonly entries = new Map<string, FakeEntry>();
  now = 1_700_000_000_000;

  private live(key: string): FakeEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  set(key: string, value: string, px: number | null, nx: boolean): string | null {
    if (nx && this.live(key)) return null;
    this.entries.set(key, {
      value,
      expiresAt: px === null ? null : this.now + px,
    });
    return "OK";
  }

  del(key: string): number {
    return this.entries.delete(key) ? 1 : 0;
  }

  ttlOf(key: string): number | null {
    return this.live(key)?.expiresAt ?? null;
  }
}

function installFetchMock(db: FakeRedis): jest.Mock {
  const mock = jest.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as string[][];
    const cmd = body[0];
    const name = cmd[0];
    let result: unknown = null;

    if (name === "GET") {
      result = db.get(cmd[1]);
    } else if (name === "DEL") {
      result = db.del(cmd[1]);
    } else if (name === "SET") {
      const key = cmd[1];
      const value = cmd[2];
      let px: number | null = null;
      let nx = false;
      for (let i = 3; i < cmd.length; i++) {
        if (cmd[i] === "PX") px = Number(cmd[i + 1]);
        if (cmd[i] === "NX") nx = true;
      }
      result = db.set(key, value, px, nx);
    } else {
      return {
        ok: true,
        status: 200,
        json: async () => [{ error: `unknown command ${name}` }],
      } as unknown as Response;
    }

    return {
      ok: true,
      status: 200,
      json: async () => [{ result }],
    } as unknown as Response;
  });

  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeStore(db: FakeRedis, ttlMs = 60_000): RedisIdempotencyStore {
  installFetchMock(db);
  return new RedisIdempotencyStore({
    redisUrl: "https://fake-redis.example.com/",
    redisToken: "token",
    namespace: "settle",
    ttlMs,
    timeoutMs: 50,
  });
}

const RECORD = {
  fingerprint: "f".repeat(64),
  statusCode: 200,
  body: { data: { id: "stream-1" } },
  createdAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Store behaviour
// ---------------------------------------------------------------------------

describe("RedisIdempotencyStore", () => {
  it("returns null when no record exists", async () => {
    const store = makeStore(new FakeRedis());
    await expect(store.get("key-1")).resolves.toBeNull();
  });

  it("stores records under the versioned namespace with a native TTL", async () => {
    const db = new FakeRedis();
    const store = makeStore(db);

    await store.set("key-1", RECORD);

    const storageKey = `${IDEMPOTENCY_KEY_PREFIX}settle:key-1`;
    expect(db.get(storageKey)).toBe(JSON.stringify(RECORD));
    expect(db.ttlOf(storageKey)).toBe(db.now + 60_000);
    await expect(store.get("key-1")).resolves.toEqual(RECORD);
  });

  it("expires records through the Redis TTL without a cleanup job", async () => {
    const db = new FakeRedis();
    const store = makeStore(db);

    await store.set("key-1", RECORD);
    db.now += 60_001;

    await expect(store.get("key-1")).resolves.toBeNull();
  });

  it("treats malformed stored JSON as a cache miss", async () => {
    const db = new FakeRedis();
    const store = makeStore(db);
    db.set(`${IDEMPOTENCY_KEY_PREFIX}settle:key-1`, "{not json", null, false);

    await expect(store.get("key-1")).resolves.toBeNull();
  });

  it("round-trips keys containing URL and separator characters", async () => {
    const db = new FakeRedis();
    const store = makeStore(db);
    const key = "stream-a:key/with?chars&x=1";

    await store.set(key, RECORD);

    expect(db.entries.has(`${IDEMPOTENCY_KEY_PREFIX}settle:${key}`)).toBe(true);
    await expect(store.get(key)).resolves.toEqual(RECORD);
  });

  it("lets exactly one of two parallel reserves win", async () => {
    const store = makeStore(new FakeRedis());

    const [first, second] = await Promise.all([
      store.reserve("key-1", 30_000),
      store.reserve("key-1", 30_000),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("release frees a reservation so a retry can claim it", async () => {
    const store = makeStore(new FakeRedis());

    expect(await store.reserve("key-1", 30_000)).toBe(true);
    expect(await store.reserve("key-1", 30_000)).toBe(false);

    await store.release("key-1");

    expect(await store.reserve("key-1", 30_000)).toBe(true);
  });

  it("lets a completed record replace its reservation", async () => {
    const db = new FakeRedis();
    const store = makeStore(db);

    expect(await store.reserve("key-1", 30_000)).toBe(true);
    await store.set("key-1", RECORD);

    await expect(store.get("key-1")).resolves.toEqual(RECORD);
    expect(await store.reserve("key-1", 30_000)).toBe(false);
  });

  it("propagates transport failures so callers can fail open", async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new DOMException("Aborted", "AbortError")),
    ) as unknown as typeof fetch;

    const store = new RedisIdempotencyStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      namespace: "settle",
    });

    await expect(store.get("key-1")).rejects.toThrow();
    await expect(store.set("key-1", RECORD)).rejects.toThrow();
    await expect(store.reserve("key-1", 1_000)).rejects.toThrow();
  });

  it("surfaces Redis protocol errors", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ error: "WRONGTYPE" }],
    })) as unknown as typeof fetch;

    const store = new RedisIdempotencyStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      namespace: "settle",
    });

    await expect(store.get("key-1")).rejects.toThrow("WRONGTYPE");
  });
});

// ---------------------------------------------------------------------------
// withIdempotency integration
// ---------------------------------------------------------------------------

function postRequest(key: string, body: unknown = {}): Request {
  return new Request("http://localhost/api/streams/stream-a/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withIdempotency with a reserving store", () => {
  it("runs the handler once and gives the loser a deterministic 409", async () => {
    const store = makeStore(new FakeRedis());
    const gate = deferred<void>();
    const handlerStarted = deferred<void>();
    const handler = jest.fn(async () => {
      handlerStarted.resolve();
      await gate.promise;
      return NextResponse.json({ data: { ok: true } }, { status: 200 });
    });

    const winner = withIdempotency(postRequest("key-1"), "settle", store, handler, {
      resourceId: "stream-a",
    });

    // Wait until the winner has claimed the key and entered the handler.
    await handlerStarted.promise;

    const loser = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: "stream-a" },
    );
    expect(loser.status).toBe(409);
    expect((await loser.json()).error).toBe("IdempotencyKeyInProgress");
    expect(loser.headers.get("Retry-After")).toBe("1");

    gate.resolve();
    const first = await winner;
    expect(first.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("replays the winner's record to a request that lost the reservation late", async () => {
    const store = makeStore(new FakeRedis());

    const handler = jest.fn(async () =>
      NextResponse.json({ data: { ok: true } }, { status: 200 }),
    );

    const first = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: "stream-a" },
    );
    expect(first.status).toBe(200);

    const replay = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: "stream-a" },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replay")).toBe("true");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation when the handler throws", async () => {
    const store = makeStore(new FakeRedis());
    const handler = jest.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      withIdempotency(postRequest("key-1"), "settle", store, handler, {
        resourceId: "stream-a",
      }),
    ).rejects.toThrow("boom");

    expect(await store.reserve("9:stream-a:key-1", 1_000)).toBe(true);
  });

  it("fails open when the store is unreachable", async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.reject(new DOMException("Aborted", "AbortError")),
    ) as unknown as typeof fetch;

    const store = new RedisIdempotencyStore({
      redisUrl: "https://fake-redis.example.com",
      redisToken: "token",
      namespace: "settle",
    });
    const handler = jest.fn(async () =>
      NextResponse.json({ data: { ok: true } }, { status: 200 }),
    );

    const res = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: "stream-a" },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replay")).toBe("false");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Factory selection
// ---------------------------------------------------------------------------

describe("createIdempotencyStore", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.IDEMPOTENCY_REDIS_URL;
    delete process.env.IDEMPOTENCY_REDIS_TOKEN;
    delete process.env.RATE_LIMIT_REDIS_URL;
    delete process.env.RATE_LIMIT_REDIS_TOKEN;
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("uses the in-memory store when no Redis config is present", () => {
    const store = createIdempotencyStore("settle");
    expect(store).not.toBeInstanceOf(RedisIdempotencyStore);
    expect(typeof store.reserve).toBe("undefined");
  });

  it("uses Redis when IDEMPOTENCY_REDIS_* is configured", () => {
    process.env.IDEMPOTENCY_REDIS_URL = "https://fake-redis.example.com";
    process.env.IDEMPOTENCY_REDIS_TOKEN = "token";

    expect(createIdempotencyStore("settle")).toBeInstanceOf(
      RedisIdempotencyStore,
    );
  });

  it("falls back to the shared RATE_LIMIT_REDIS_* credentials", () => {
    process.env.RATE_LIMIT_REDIS_URL = "https://fake-redis.example.com";
    process.env.RATE_LIMIT_REDIS_TOKEN = "token";

    expect(createIdempotencyStore("withdraw")).toBeInstanceOf(
      RedisIdempotencyStore,
    );
  });
});
