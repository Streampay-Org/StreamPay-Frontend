/**
 * @jest-environment node
 *
 * Regression tests for issue #1720.
 *
 * `withIdempotency` used to key its records by the raw `Idempotency-Key` inside
 * a per-route namespace, so the same key reused on a different stream replayed
 * the first stream's cached response. Records are now bound to the stream id
 * and to the acting wallet.
 */

import { NextResponse } from "next/server";
import { db, resetDb } from "@/app/lib/db";
import {
  createNamespacedStore,
  scopedIdempotencyKey,
  withIdempotency,
} from "@/app/lib/idempotency";

const STREAM_A = "stream-a";
const STREAM_B = "stream-b";

function postRequest(key: string | null, body: unknown = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) {
    headers["Idempotency-Key"] = key;
  }
  return new Request("http://localhost/api/streams/stream-a/settle", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function okHandler(payload: unknown) {
  return jest.fn(async () => NextResponse.json(payload, { status: 200 }));
}

beforeEach(() => {
  resetDb();
});

describe("scopedIdempotencyKey", () => {
  it("binds the client key to the resource id", () => {
    expect(scopedIdempotencyKey(STREAM_A, "key-1")).toBe(
      STREAM_A.length + ":" + STREAM_A + ":key-1",
    );
  });

  it("never collides across different resource and key pairs", () => {
    expect(scopedIdempotencyKey("a", "b:c")).not.toBe(
      scopedIdempotencyKey("a:b", "c"),
    );
  });
});

describe("withIdempotency", () => {
  it("returns 400 when the Idempotency-Key header is missing", async () => {
    const store = createNamespacedStore("scope-test");
    const handler = okHandler({ data: { id: STREAM_A } });

    const res = await withIdempotency(
      postRequest(null),
      "settle",
      store,
      handler,
      { resourceId: STREAM_A },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("IdempotencyKeyRequired");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 when the Idempotency-Key header is malformed", async () => {
    const store = createNamespacedStore("scope-test");
    const handler = okHandler({ data: { id: STREAM_A } });

    const res = await withIdempotency(
      postRequest("has spaces"),
      "settle",
      store,
      handler,
      { resourceId: STREAM_A },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("IdempotencyKeyInvalid");
    expect(handler).not.toHaveBeenCalled();
  });

  it("replays the original response for an identical retry", async () => {
    const store = createNamespacedStore("scope-test");
    const handler = okHandler({ data: { id: STREAM_A } });

    const first = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: STREAM_A },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("Idempotency-Replay")).toBe("false");

    const second = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      handler,
      { resourceId: STREAM_A },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotency-Replay")).toBe("true");
    expect(await second.json()).toEqual({ data: { id: STREAM_A } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not replay another stream's response for the same key", async () => {
    const store = createNamespacedStore("scope-test");
    const handlerA = okHandler({ data: { id: STREAM_A } });
    const handlerB = okHandler({ data: { id: STREAM_B } });

    await withIdempotency(
      postRequest("shared-key"),
      "settle",
      store,
      handlerA,
      { resourceId: STREAM_A },
    );

    const res = await withIdempotency(
      postRequest("shared-key"),
      "settle",
      store,
      handlerB,
      { resourceId: STREAM_B },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotency-Replay")).toBe("false");
    expect(await res.json()).toEqual({ data: { id: STREAM_B } });
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  it("keeps one record per resource for the same client key", async () => {
    const store = createNamespacedStore("scope-test");

    await withIdempotency(
      postRequest("shared-key"),
      "settle",
      store,
      okHandler({ data: { id: STREAM_A } }),
      { resourceId: STREAM_A },
    );
    await withIdempotency(
      postRequest("shared-key"),
      "settle",
      store,
      okHandler({ data: { id: STREAM_B } }),
      { resourceId: STREAM_B },
    );

    expect(db.idempotency.size).toBe(2);
  });

  it("rejects a replay attempted by a different caller", async () => {
    const store = createNamespacedStore("scope-test");

    await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      okHandler({ data: { id: STREAM_A } }),
      { resourceId: STREAM_A, actorId: "GAAA" },
    );

    const res = await withIdempotency(
      postRequest("key-1"),
      "settle",
      store,
      okHandler({ data: { id: STREAM_A } }),
      { resourceId: STREAM_A, actorId: "GBBB" },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("IdempotencyKeyReused");
  });

  it("rejects the same key with a different request body", async () => {
    const store = createNamespacedStore("scope-test");

    await withIdempotency(
      postRequest("key-1", { a: 1 }),
      "settle",
      store,
      okHandler({ data: { id: STREAM_A } }),
      { resourceId: STREAM_A },
    );

    const res = await withIdempotency(
      postRequest("key-1", { a: 2 }),
      "settle",
      store,
      okHandler({ data: { id: STREAM_A } }),
      { resourceId: STREAM_A },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("IdempotencyKeyReused");
  });
});
