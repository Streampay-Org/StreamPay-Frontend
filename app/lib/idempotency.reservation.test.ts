/** @jest-environment node */
import { NextResponse } from "next/server";
import { resetDb } from "@/app/lib/db";
import { createNamespacedStore, scopedIdempotencyKey, withIdempotency } from "./idempotency";
const scope = { resourceId: "reservation-test" };
function request() {
  return new Request("https://example.test/api/settle", { method: "POST",
    headers: { "Idempotency-Key": "same-key" }, body: "{}" });
}
beforeEach(() => resetDb());
test("parallel duplicates execute once and preserve the successful replay", async () => {
  const store = createNamespacedStore("reservation-test");
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = jest.fn(async () => { started(); await gate; return NextResponse.json({ ok: true }); });
  const first = withIdempotency(request(), "settle", store, handler, scope);
  await running;
  const second = await withIdempotency(request(), "settle", store, handler, scope);
  expect(second.status).toBe(409);
  expect(second.headers.get("Retry-After")).toBe("1");
  release();
  expect((await first).status).toBe(200);
  expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(200);
  expect(handler).toHaveBeenCalledTimes(1);
});
test.each([429, 500, 502, 503])("releases status %s for a real retry", async status => {
  const store = createNamespacedStore("reservation-test");
  const handler = jest.fn().mockResolvedValueOnce(NextResponse.json({}, { status }))
    .mockResolvedValueOnce(NextResponse.json({ ok: true }));
  expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(status);
  expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(200);
  expect(handler).toHaveBeenCalledTimes(2);
});
test("releases a thrown handler", async () => {
  const store = createNamespacedStore("reservation-test");
  const handler = jest.fn().mockRejectedValueOnce(new Error("chain unavailable"))
    .mockResolvedValueOnce(NextResponse.json({ ok: true }));
  await expect(withIdempotency(request(), "settle", store, handler, scope)).rejects.toThrow("chain unavailable");
  expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(200);
});
test("store read failure refuses to execute a money-moving handler", async () => {
  const store = createNamespacedStore("reservation-test");
  store.get = jest.fn().mockRejectedValue(new Error("offline"));
  const handler = jest.fn();
  expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(503);
  expect(handler).not.toHaveBeenCalled();
});
test("deterministic state conflicts are replayed", async () => {
  const store = createNamespacedStore("reservation-test");
  const handler = jest.fn(async () => NextResponse.json({ error: "INVALID_STREAM_STATE" }, { status: 409 }));
  await withIdempotency(request(), "settle", store, handler, scope);
  const response = await withIdempotency(request(), "settle", store, handler, scope);
  expect(response.status).toBe(409);
  expect(response.headers.get("Idempotency-Replay")).toBe("true");
  expect(handler).toHaveBeenCalledTimes(1);
});

test("an abandoned reservation expires and a later request can execute", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const store = createNamespacedStore("reservation-test");
    await store.setIfAbsent!(scopedIdempotencyKey(scope.resourceId, "same-key"), {
      fingerprint: "abandoned", statusCode: 0, body: null, createdAt: 1000, reservationId: "old",
    });
    clock.mockReturnValue(32_000);
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));
    expect((await withIdempotency(request(), "settle", store, handler, scope)).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  } finally { clock.mockRestore(); }
});
test("an expired owner cannot overwrite a replacement reservation", async () => {
  const store = createNamespacedStore("reservation-test");
  const record = { fingerprint: "fp", statusCode: 0, body: null, createdAt: Date.now(), reservationId: "old" };
  await store.setIfAbsent!("key", record);
  await store.release!("key", "old");
  await store.setIfAbsent!("key", { ...record, reservationId: "new" });
  expect(await store.commit!("key", "old", { ...record, statusCode: 200 })).toBe(false);
  expect((await store.get("key"))?.reservationId).toBe("new");
});
