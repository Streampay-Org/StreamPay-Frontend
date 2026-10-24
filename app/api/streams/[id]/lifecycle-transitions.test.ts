/** @jest-environment node */

import { POST as cancelPOST } from "./cancel/route";
import { POST as settlePOST } from "./settle/route";
import { db, resetDb } from "@/app/lib/db";
import { resetAuditLogStore } from "@/app/lib/audit-log";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

const STREAM_ID = "lifecycle-stream";
const ACTOR = "GACTOR";
const context = { params: Promise.resolve({ id: STREAM_ID }) };
const settleStream = jest.fn();

function stream(status: "ended" | "cancelled") {
  return {
    id: STREAM_ID,
    recipient: "GRECIPIENT",
    senderAddress: ACTOR,
    rate: "1",
    schedule: "daily",
    status,
    nextAction: status === "ended" ? "withdraw" as const : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    token: "XLM",
  };
}

beforeEach(() => {
  resetDb({ [STREAM_ID]: stream("ended") });
  resetAuditLogStore();
  resetRateLimitStore();
  settleStream.mockClear();
  globalThis.__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
    settleStream,
  };
});

afterEach(() => {
  globalThis.__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = undefined;
});

it("settling an ended stream is an unchanged no-op without a chain call", async () => {
  const before = structuredClone(db.streams.get(STREAM_ID));
  const response = await settlePOST(
    new Request(`http://localhost/api/streams/${STREAM_ID}/settle`, { method: "POST" }),
    context,
  );

  expect(response.status).toBe(200);
  expect((await response.json()).data).toEqual(before);
  expect(db.streams.get(STREAM_ID)).toEqual(before);
  expect(settleStream).not.toHaveBeenCalled();
});

it("cancelling a cancelled stream is rejected by the transition table", async () => {
  db.streams.set(STREAM_ID, stream("cancelled"));

  const response = await cancelPOST(
    new Request(`http://localhost/api/streams/${STREAM_ID}/cancel`, {
      method: "POST",
      headers: { "Actor-Wallet-Address": ACTOR },
    }),
    context,
  );

  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({
    code: "ILLEGAL_TRANSITION",
    legacy_code: "INVALID_STREAM_STATE",
    message: "Action 'cancel' is illegal for a stream in 'cancelled' state.",
  });
});
