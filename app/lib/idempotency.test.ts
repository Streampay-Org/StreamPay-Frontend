import { NextResponse } from "next/server";
import {
  checkIdempotency,
  computeFingerprint,
  createInMemoryPersistenceStore,
  IdempotencyEntry,
  IDEMPOTENCY_TTL_MS,
  idempotencyToken,
  setIdempotency,
} from "@/app/lib/db";
import {
  idempotencyKeyErrorResponse,
  validateIdempotencyKey,
  withIdempotency,
  type IdempotencyStore,
} from "@/app/lib/idempotency";
import { withCorrelationContext } from "@/app/lib/logger";

function createStore() {
  return createInMemoryPersistenceStore().idempotencyStore;
}

describe("computeFingerprint", () => {
  it("produces a deterministic SHA-256 hex string", () => {
    const a = computeFingerprint("POST", "/api/streams", { rate: "100" });
    const b = computeFingerprint("POST", "/api/streams", { rate: "100" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different methods", () => {
    const a = computeFingerprint("POST", "/api/streams", null);
    const b = computeFingerprint("GET", "/api/streams", null);
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different paths", () => {
    const a = computeFingerprint("POST", "/api/streams/1/start", null);
    const b = computeFingerprint("POST", "/api/streams/2/start", null);
    expect(a).not.toBe(b);
  });

  it("produces different hashes for different bodies", () => {
    const a = computeFingerprint("POST", "/api/streams", { rate: "100" });
    const b = computeFingerprint("POST", "/api/streams", { rate: "200" });
    expect(a).not.toBe(b);
  });

  it("handles null body", () => {
    const result = computeFingerprint("POST", "/api/streams", null);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles undefined body", () => {
    const result = computeFingerprint("POST", "/api/streams", undefined);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalises JSON so key order does not affect fingerprint", () => {
    const a = computeFingerprint("POST", "/api/streams", { a: 1, b: 2 });
    const b = computeFingerprint("POST", "/api/streams", { b: 2, a: 1 });
    expect(a).toBe(b);
  });
});

describe("idempotencyToken", () => {
  it("scopes tokens correctly", () => {
    expect(idempotencyToken("streams.create", "abc")).toBe("streams.create:abc");
  });

  it("includes both scope and key", () => {
    const t1 = idempotencyToken("streams.start.x", "key-1");
    const t2 = idempotencyToken("streams.start.y", "key-1");
    const t3 = idempotencyToken("streams.start.x", "key-2");
    expect(t1).not.toBe(t2);
    expect(t1).not.toBe(t3);
    expect(t2).not.toBe(t3);
  });
});

describe("checkIdempotency / setIdempotency", () => {
  it("returns null when no entry exists", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);
    expect(checkIdempotency(store, "missing-key", fp)).toBeNull();
  });

  it("returns cached response on identical replay", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", { rate: "100" });
    const body = { data: { id: "s1" } };

    setIdempotency(store, "token-1", fp, 201, body);

    const result = checkIdempotency(store, "token-1", fp);
    expect(result).toEqual({ ok: true, status: 201, body });
  });

  it("returns conflict on different body with same key", () => {
    const store = createStore();
    const fp1 = computeFingerprint("POST", "/api/streams", { rate: "100" });
    const fp2 = computeFingerprint("POST", "/api/streams", { rate: "200" });

    setIdempotency(store, "token-1", fp1, 201, { data: { id: "s1" } });

    const result = checkIdempotency(store, "token-1", fp2);
    expect(result).toEqual({ ok: false, conflict: true });
  });

  it("returns conflict on different method with same key", () => {
    const store = createStore();
    const fp1 = computeFingerprint("POST", "/api/streams/1/start", null);
    const fp2 = computeFingerprint("POST", "/api/streams/2/start", null);

    setIdempotency(store, "token-1", fp1, 200, { data: { status: "active" } });

    const result = checkIdempotency(store, "token-1", fp2);
    expect(result).toEqual({ ok: false, conflict: true });
  });

  it("returns null and evicts expired entries (lazy eviction)", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);

    const expiredEntry: IdempotencyEntry = {
      fingerprint: fp,
      expiresAt: Date.now() - 1000,
      status: 200,
      body: { data: "stale" },
    };
    store.set("expired-token", expiredEntry);

    const result = checkIdempotency(store, "expired-token", fp);
    expect(result).toBeNull();
    expect(store.has("expired-token")).toBe(false);
  });

  it("keeps non-expired entries after check", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);

    setIdempotency(store, "token-1", fp, 200, { data: "fresh" });

    expect(checkIdempotency(store, "token-1", fp)).not.toBeNull();
    expect(store.has("token-1")).toBe(true);
  });

  it("supports multiple independent tokens", () => {
    const store = createStore();
    const fp1 = computeFingerprint("POST", "/api/streams/1/start", null);
    const fp2 = computeFingerprint("POST", "/api/streams/2/stop", null);

    setIdempotency(store, "token-1", fp1, 200, { data: { id: "s1", status: "active" } });
    setIdempotency(store, "token-2", fp2, 200, { data: { id: "s2", status: "ended" } });

    const r1 = checkIdempotency(store, "token-1", fp1);
    expect(r1).toEqual({ ok: true, status: 200, body: { data: { id: "s1", status: "active" } } });

    const r2 = checkIdempotency(store, "token-2", fp2);
    expect(r2).toEqual({ ok: true, status: 200, body: { data: { id: "s2", status: "ended" } } });
  });

  it("stores IdempotencyEntry with correct structure", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);
    const body = { data: { id: "s1" } };

    setIdempotency(store, "token-1", fp, 201, body);

    const raw = store.get("token-1") as IdempotencyEntry;
    expect(raw).toHaveProperty("fingerprint", fp);
    expect(raw).toHaveProperty("expiresAt");
    expect(raw).toHaveProperty("status", 201);
    expect(raw).toHaveProperty("body", body);
    expect(typeof raw.expiresAt).toBe("number");
    expect(raw.expiresAt).toBeGreaterThan(Date.now());
    expect(raw.expiresAt).toBeLessThanOrEqual(Date.now() + IDEMPOTENCY_TTL_MS);
  });

  it("respects default 24h TTL", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(86_400_000);
  });

  it("handles large request bodies", () => {
    const store = createStore();
    const largeBody = { data: "x".repeat(100_000) };
    const fp = computeFingerprint("POST", "/api/streams", largeBody);

    setIdempotency(store, "large-token", fp, 200, largeBody);

    const result = checkIdempotency(store, "large-token", fp);
    expect(result).toEqual({ ok: true, status: 200, body: largeBody });
  });

  it("evicts only the expired entry, leaving others intact", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);

    setIdempotency(store, "fresh", fp, 200, { data: "good" });

    const expiredEntry: IdempotencyEntry = {
      fingerprint: fp,
      expiresAt: Date.now() - 1,
      status: 200,
      body: { data: "stale" },
    };
    store.set("stale", expiredEntry);

    checkIdempotency(store, "stale", fp);
    expect(store.has("stale")).toBe(false);
    expect(store.has("fresh")).toBe(true);
  });

  it("evicts malformed entries (old-format raw payloads)", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);

    // Simulate an old-format entry (raw response body, not an IdempotencyEntry)
    store.set("malformed", { data: "old-format-response" });

    const result = checkIdempotency(store, "malformed", fp);
    expect(result).toBeNull();
    expect(store.has("malformed")).toBe(false);
  });

  it("evicts entries with missing fingerprint field", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", null);

    store.set("missing-fp", { expiresAt: Date.now() + 3600000, status: 200, body: {} });

    const result = checkIdempotency(store, "missing-fp", fp);
    expect(result).toBeNull();
    expect(store.has("missing-fp")).toBe(false);
  });

  it("overwrites existing entry on new setIdempotency call", () => {
    const store = createStore();
    const fp1 = computeFingerprint("POST", "/api/streams", { v: 1 });
    const fp2 = computeFingerprint("POST", "/api/streams", { v: 2 });

    setIdempotency(store, "token-1", fp1, 200, { data: "first" });
    setIdempotency(store, "token-1", fp2, 201, { data: "second" });

    const result = checkIdempotency(store, "token-1", fp2);
    expect(result).toEqual({ ok: true, status: 201, body: { data: "second" } });
  });
});

describe("integration with InMemoryIdempotencyStore", () => {
  it("works with the real store backend through getStore", () => {
    const store = createStore();
    const fp = computeFingerprint("POST", "/api/streams", { rate: "100" });

    setIdempotency(store, "test-key", fp, 201, { data: { id: "s1" } });

    expect(store.has("test-key")).toBe(true);
    expect(store.size).toBe(1);
  });

  it("persists across store lifecycle", () => {
    const persistence = createInMemoryPersistenceStore();
    const store = persistence.idempotencyStore;
    const fp = computeFingerprint("POST", "/api/streams", { rate: "100" });

    setIdempotency(store, "persist-key", fp, 200, { status: "ok" });

    persistence.idempotencyStore.reset();
    expect(store.size).toBe(0);
  });
});

describe("validateIdempotencyKey", () => {
  it("accepts a 1-character printable ASCII key", () => {
    expect(validateIdempotencyKey("a")).toEqual({ ok: true, key: "a" });
  });

  it("accepts a 255-character printable ASCII key", () => {
    const key = "k".repeat(255);
    expect(validateIdempotencyKey(key)).toEqual({ ok: true, key });
  });

  it("rejects a 256-character key with too_long", () => {
    const key = "k".repeat(256);
    expect(validateIdempotencyKey(key)).toEqual({ ok: false, reason: "too_long" });
  });

  it("rejects null and undefined with missing", () => {
    expect(validateIdempotencyKey(null)).toEqual({ ok: false, reason: "missing" });
    expect(validateIdempotencyKey(undefined)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an empty string with empty", () => {
    expect(validateIdempotencyKey("")).toEqual({ ok: false, reason: "empty" });
  });

  it.each([
    ["space", "key with space"],
    ["tab", "key\twith\ttab"],
    ["newline", "key\nwith\nnewline"],
    ["carriage return", "key\rwith\rcr"],
    ["NUL", "key\u0000null"],
    ["non-ASCII", "key-caf\u00e9"],
    ["emoji", "key-\uD83D\uDE80"],
  ])("rejects %s with invalid_chars", (_label, key) => {
    expect(validateIdempotencyKey(key)).toEqual({ ok: false, reason: "invalid_chars" });
  });
});

describe("withIdempotency validation and standard error envelope", () => {
  function makeMockStore(): IdempotencyStore & { get: jest.Mock; set: jest.Mock } {
    return {
      get: jest.fn(async () => null),
      set: jest.fn(async () => undefined),
    };
  }

  it("returns 400 with standard envelope and request_id when header is missing", async () => {
    const store = makeMockStore();
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    const req = new Request("http://localhost/api/streams/s1/settle", { method: "POST" });

    const res = await withCorrelationContext({ request_id: "req-missing-1" }, () =>
      withIdempotency(req, "settle", store, handler, { resourceId: "s1" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key header is required for mutating operations",
        request_id: "req-missing-1",
      },
    });
    expect(store.get).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 with standard envelope and request_id when key is too long", async () => {
    const store = makeMockStore();
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    const req = new Request("http://localhost/api/streams/s1/settle", {
      method: "POST",
      headers: { "Idempotency-Key": "a".repeat(256) },
    });

    const res = await withCorrelationContext({ request_id: "req-long-1" }, () =>
      withIdempotency(req, "settle", store, handler, { resourceId: "s1" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key must be at most 255 characters",
        request_id: "req-long-1",
      },
    });
    expect(store.get).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 with standard envelope for invalid characters without hitting store or handler", async () => {
    const store = makeMockStore();
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    const req = new Request("http://localhost/api/streams/s1/settle", {
      method: "POST",
      headers: { "Idempotency-Key": "bad key" },
    });

    const res = await withCorrelationContext({ request_id: "req-chars-1" }, () =>
      withIdempotency(req, "settle", store, handler, { resourceId: "s1" }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_INVALID",
        message:
          "Idempotency-Key must contain only printable ASCII characters (0x21-0x7E) with no spaces or control characters",
        request_id: "req-chars-1",
      },
    });
    expect(store.get).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("formats empty key error via idempotencyKeyErrorResponse", async () => {
    const res = await withCorrelationContext({ request_id: "req-empty-1" }, async () =>
      idempotencyKeyErrorResponse("empty"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "IDEMPOTENCY_KEY_INVALID",
        message: "Idempotency-Key must not be empty",
        request_id: "req-empty-1",
      },
    });
  });
});
