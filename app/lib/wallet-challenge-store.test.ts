import {
  buildAddressIndexKey,
  buildChallengeRecordKey,
  CONSUME_CHALLENGE_LUA,
  createWalletChallengeStore,
  InMemoryWalletChallengeStore,
  ISSUE_CHALLENGE_LUA,
  RedisWalletChallengeStore,
  WALLET_CHALLENGE_PER_ADDRESS_MAX,
  WALLET_CHALLENGE_TTL_MS,
  WalletChallengeStoreUnavailableError,
  type WalletChallengeRecord,
} from "./wallet-challenge-store";

const ADDR_A = "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";
const ADDR_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeRecord(
  id: string,
  address: string,
  nowMs: number,
  ttlMs = WALLET_CHALLENGE_TTL_MS,
): WalletChallengeRecord {
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const nonce = `${id}_`.padEnd(43, "A");
  return {
    id,
    address,
    challenge: `streampay-auth:v1:${nonce}|http://localhost|${expiresAt}`,
    created_at: new Date(nowMs).toISOString(),
    expires_at: expiresAt,
  };
}

/**
 * In-memory fake of the Upstash `/pipeline` REST endpoint that executes the
 * `ISSUE_CHALLENGE_LUA` and `CONSUME_CHALLENGE_LUA` commands atomically.
 */
function createFakeUpstashRedis(nowFn: () => number) {
  const kv = new Map<string, { value: string; expiresAtMs: number }>();
  const zsets = new Map<string, Map<string, number>>();

  const getKv = (key: string): string | null => {
    const entry = kv.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowFn()) {
      kv.delete(key);
      return null;
    }
    return entry.value;
  };

  const fakeFetch = jest.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const commands = JSON.parse(String(init?.body)) as string[][];
      const results = commands.map((cmd) => {
        const [op, script, numKeysStr, ...rest] = cmd;
        if (op !== "EVAL") {
          return { error: `Unsupported op: ${op}` };
        }
        const numKeys = Number.parseInt(numKeysStr, 10);
        const keys = rest.slice(0, numKeys);
        const args = rest.slice(numKeys);

        if (script === ISSUE_CHALLENGE_LUA) {
          const [zkey, rkey] = keys;
          const [id, payload, nowMsStr, expiresMsStr, ttlMsStr, maxStr, keyPrefix] = args;
          const nowMs = Number(nowMsStr);
          const expiresMs = Number(expiresMsStr);
          const ttlMs = Number(ttlMsStr);
          const maxPerAddr = Number(maxStr);

          const zset = zsets.get(zkey) ?? new Map<string, number>();
          // Prune expired
          for (const [oldId, score] of Array.from(zset.entries())) {
            if (score <= nowMs) {
              kv.delete(`${keyPrefix}${oldId}`);
              zset.delete(oldId);
            }
          }
          // Evict oldest above cap
          if (zset.size >= maxPerAddr) {
            const sorted = Array.from(zset.entries()).sort((a, b) => a[1] - b[1]);
            const toEvict = zset.size - maxPerAddr + 1;
            for (const [oldId] of sorted.slice(0, toEvict)) {
              kv.delete(`${keyPrefix}${oldId}`);
              zset.delete(oldId);
            }
          }
          // Store new record with PX TTL
          kv.set(rkey, { value: payload, expiresAtMs: nowFn() + ttlMs });
          zset.set(id, expiresMs);
          zsets.set(zkey, zset);
          return { result: 1 };
        }

        if (script === CONSUME_CHALLENGE_LUA) {
          const [zkey] = keys;
          const [challenge, keyPrefix] = args;
          const zset = zsets.get(zkey);
          if (!zset) return { result: null };

          const sortedIds = Array.from(zset.entries())
            .sort((a, b) => a[1] - b[1])
            .map(([id]) => id);

          for (const id of sortedIds) {
            const rkey = `${keyPrefix}${id}`;
            const payload = getKv(rkey);
            if (payload === null) {
              zset.delete(id);
              continue;
            }
            const nl = payload.indexOf("\n");
            if (nl !== -1 && payload.slice(0, nl) === challenge) {
              kv.delete(rkey);
              zset.delete(id);
              return { result: payload.slice(nl + 1) };
            }
          }
          return { result: null };
        }

        return { error: "Unknown Lua script" };
      });

      return {
        ok: true,
        status: 200,
        json: async () => results,
      } as unknown as Response;
    },
  );

  return { fakeFetch, kv, zsets };
}

describe("InMemoryWalletChallengeStore", () => {
  it("issues and atomically consumes a challenge once", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryWalletChallengeStore({ nowFn: () => now });
    const record = makeRecord("id-1", ADDR_A, now);

    await store.issue(record);
    expect(store.size()).toBe(1);

    const consumed = await store.consume(ADDR_A, record.challenge);
    expect(consumed).toEqual(record);
    expect(store.size()).toBe(0);

    // Replay always fails
    const replay = await store.consume(ADDR_A, record.challenge);
    expect(replay).toBeNull();
  });

  it("allows only one winner under two parallel consume() calls", async () => {
    const now = 1_700_000_000_000;
    const store = new InMemoryWalletChallengeStore({ nowFn: () => now });
    const record = makeRecord("id-race", ADDR_A, now);

    await store.issue(record);

    const [first, second] = await Promise.all([
      store.consume(ADDR_A, record.challenge),
      store.consume(ADDR_A, record.challenge),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(record);
  });

  it("prunes expired challenges on pruneExpired() and on subsequent issue()", async () => {
    let now = 1_700_000_000_000;
    const store = new InMemoryWalletChallengeStore({ nowFn: () => now });

    const r1 = makeRecord("exp-1", ADDR_A, now, 10_000);
    await store.issue(r1);
    expect(store.size()).toBe(1);

    now += 15_000;
    await store.pruneExpired();
    expect(store.size()).toBe(0);
    expect(await store.consume(ADDR_A, r1.challenge)).toBeNull();
  });

  it("evicts the oldest challenge when exceeding the per-address cap (5)", async () => {
    let now = 1_700_000_000_000;
    const store = new InMemoryWalletChallengeStore({ nowFn: () => now });
    const records: WalletChallengeRecord[] = [];

    for (let i = 0; i < WALLET_CHALLENGE_PER_ADDRESS_MAX + 2; i++) {
      now += 100;
      const rec = makeRecord(`cap-${i}`, ADDR_A, now);
      records.push(rec);
      await store.issue(rec);
    }

    expect(store.size()).toBe(WALLET_CHALLENGE_PER_ADDRESS_MAX);
    // Oldest two were evicted
    expect(await store.consume(ADDR_A, records[0].challenge)).toBeNull();
    expect(await store.consume(ADDR_A, records[1].challenge)).toBeNull();
    // Newest is still live
    expect(await store.consume(ADDR_A, records[6].challenge)).toEqual(records[6]);
  });

  it("evicts oldest globally when exceeding globalMax", async () => {
    let now = 1_700_000_000_000;
    const store = new InMemoryWalletChallengeStore({
      globalMax: () => 2,
      nowFn: () => now,
    });

    const r1 = makeRecord("g-1", ADDR_A, now);
    const r2 = makeRecord("g-2", ADDR_B, now + 10);
    const r3 = makeRecord("g-3", ADDR_B, now + 20);

    await store.issue(r1);
    await store.issue(r2);
    await store.issue(r3);

    expect(store.size()).toBe(2);
    expect(await store.consume(ADDR_A, r1.challenge)).toBeNull();
    expect(await store.consume(ADDR_B, r2.challenge)).toEqual(r2);
  });
});

describe("RedisWalletChallengeStore", () => {
  it("stores keys with streampay:wallet-challenge:v1:<address>:<id> and consumes atomically", async () => {
    const now = 1_700_000_000_000;
    const { fakeFetch, kv } = createFakeUpstashRedis(() => now);
    const store = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      nowFn: () => now,
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const record = makeRecord("redis-1", ADDR_A, now);
    await store.issue(record);

    expect(kv.has(buildChallengeRecordKey(ADDR_A, record.id))).toBe(true);

    const consumed = await store.consume(ADDR_A, record.challenge);
    expect(consumed).toEqual(record);
    expect(kv.has(buildChallengeRecordKey(ADDR_A, record.id))).toBe(false);

    // Replay returns null
    expect(await store.consume(ADDR_A, record.challenge)).toBeNull();
  });

  it("allows only one winner under two parallel consume() calls", async () => {
    const now = 1_700_000_000_000;
    const { fakeFetch } = createFakeUpstashRedis(() => now);
    const store = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      nowFn: () => now,
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const record = makeRecord("redis-race", ADDR_A, now);
    await store.issue(record);

    const [first, second] = await Promise.all([
      store.consume(ADDR_A, record.challenge),
      store.consume(ADDR_A, record.challenge),
    ]);

    const winners = [first, second].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual(record);
  });

  it("returns null for expired challenges (PX TTL) and wrong address", async () => {
    let now = 1_700_000_000_000;
    const { fakeFetch } = createFakeUpstashRedis(() => now);
    const store = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      nowFn: () => now,
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const record = makeRecord("redis-ttl", ADDR_A, now, 5_000);
    await store.issue(record);

    // Wrong address does not find or consume the challenge
    expect(await store.consume(ADDR_B, record.challenge)).toBeNull();

    // Advance past PX TTL
    now += 6_000;
    expect(await store.consume(ADDR_A, record.challenge)).toBeNull();
  });

  it("evicts the oldest challenge when exceeding the per-address cap (5)", async () => {
    let now = 1_700_000_000_000;
    const { fakeFetch, zsets } = createFakeUpstashRedis(() => now);
    const store = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      nowFn: () => now,
      fetchFn: fakeFetch as unknown as typeof fetch,
    });

    const records: WalletChallengeRecord[] = [];
    for (let i = 0; i < WALLET_CHALLENGE_PER_ADDRESS_MAX + 1; i++) {
      now += 100;
      const rec = makeRecord(`rcap-${i}`, ADDR_A, now);
      records.push(rec);
      await store.issue(rec);
    }

    expect(zsets.get(buildAddressIndexKey(ADDR_A))?.size).toBe(
      WALLET_CHALLENGE_PER_ADDRESS_MAX,
    );
    // Oldest was evicted
    expect(await store.consume(ADDR_A, records[0].challenge)).toBeNull();
    // Newest is still live
    expect(await store.consume(ADDR_A, records[5].challenge)).toEqual(records[5]);
  });

  it("fails closed with WalletChallengeStoreUnavailableError on Redis timeout or HTTP 500", async () => {
    const timeoutFetch = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const store = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      timeoutMs: 25,
      fetchFn: timeoutFetch as unknown as typeof fetch,
    });

    await expect(store.consume(ADDR_A, "any-challenge")).rejects.toThrow(
      WalletChallengeStoreUnavailableError,
    );

    const errorFetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => [],
    }));

    const store503 = new RedisWalletChallengeStore({
      redisUrl: "https://fake.upstash.io",
      redisToken: "secret-token",
      fetchFn: errorFetch as unknown as typeof fetch,
    });

    await expect(
      store503.issue(makeRecord("fail-1", ADDR_A, Date.now())),
    ).rejects.toThrow(WalletChallengeStoreUnavailableError);
  });
});

describe("createWalletChallengeStore", () => {
  it("selects InMemoryWalletChallengeStore when Redis env vars are unset", () => {
    const store = createWalletChallengeStore({});
    expect(store).toBeInstanceOf(InMemoryWalletChallengeStore);
  });

  it("selects RedisWalletChallengeStore when WALLET_CHALLENGE_REDIS_* is set", () => {
    const store = createWalletChallengeStore({
      WALLET_CHALLENGE_REDIS_URL: "https://wallet.upstash.io",
      WALLET_CHALLENGE_REDIS_TOKEN: "tok",
    });
    expect(store).toBeInstanceOf(RedisWalletChallengeStore);
  });

  it("falls back to RATE_LIMIT_REDIS_* when WALLET_CHALLENGE_REDIS_* is unset", () => {
    const store = createWalletChallengeStore({
      RATE_LIMIT_REDIS_URL: "https://rl.upstash.io",
      RATE_LIMIT_REDIS_TOKEN: "tok",
    });
    expect(store).toBeInstanceOf(RedisWalletChallengeStore);
  });
});
