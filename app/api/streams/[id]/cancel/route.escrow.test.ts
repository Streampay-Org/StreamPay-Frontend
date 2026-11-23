/** @jest-environment node */

jest.mock("@/src/middleware/rateLimit", () => ({
  streamsRateLimit: jest.fn(async () => ({ allowed: true })),
}));

import { POST as createStream } from "@/app/api/streams/route";
import { POST as cancelStream } from "./route";
import { db, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import { signToken } from "@/app/lib/auth";

jest.mock("@/app/lib/escrow-state", () => ({
  ...jest.requireActual("@/app/lib/escrow-state"),
  escrowNow: () => new Date("2026-01-01T06:00:00.000Z"),
}));

const recipient = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const sender = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const start = "2026-01-01T00:00:00.000Z";
const end = "2026-01-02T00:00:00.000Z";

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

function cancelRequest(id: string) {
  return new Request(`http://localhost/api/streams/${id}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${signToken(sender)}` },
  });
}

async function createActiveStream(fields: Record<string, unknown> = {}) {
  const created = await createStream(new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(sender)}` },
    body: JSON.stringify({ recipient, rate: "1", schedule: "day", ...fields }),
  }));
  expect(created.status).toBe(201);
  const { data } = await created.json();
  const id: string = data.id;
  db.streams.set(id, { ...db.streams.get(id)!, status: "active" });
  return id;
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
  _resetOrgDbForTesting();
});

afterEach(() => {
  resetRateLimitStore();
});

describe("POST /api/streams/[id]/cancel", () => {
  it("uses the persisted demo escrow instead of a route-specific table", async () => {
    const id = "stream-ada";
    orgDb.streamOwnership.delete(id);
    db.streams.set(id, { ...db.streams.get(id)!, senderAddress: sender, ownership: "individual" });
    const response = await cancelStream(cancelRequest(id), context(id));
    expect(response.status).toBe(200);
    expect((await response.json()).cancellation).toMatchObject({
      recipientPayout: "600000000",
      senderRefund: "1800000000",
      totalAmount: "3600000000",
    });
  });

  it.each([
    { totalAmount: "1.5" },
    { totalAmount: "0" },
    { totalAmount: (1n << 127n).toString() },
    { totalAmount: "100", startTime: end, endTime: start },
  ])("rejects malformed escrow input at creation: %o", async (fields) => {
    const response = await createStream(new Request("http://localhost/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient, rate: "1", schedule: "day", ...fields }),
    }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("uses the persisted 2e9 amount, not the old 1e9 default", async () => {
    const id = await createActiveStream({ totalAmount: "2000000000", startTime: start, endTime: end });
    expect(db.streams.get(id)).toMatchObject({ totalAmount: "2000000000", releasedAmount: "0", startTime: start, endTime: end });

    const response = await cancelStream(cancelRequest(id), context(id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cancellation).toMatchObject({
      totalAmount: "2000000000",
      alreadyReleased: "0",
      recipientPayout: "500000000",
      senderRefund: "1500000000",
    });
    expect(body.data.status).toBe("cancelled");
  });

  it("returns 422 without changing status when totalAmount is missing", async () => {
    const id = await createActiveStream();
    const response = await cancelStream(cancelRequest(id), context(id));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("ESCROW_STATE_UNAVAILABLE");
    expect(db.streams.get(id)?.status).toBe("active");
  });

  it("retains state guards when a terminal or draft record has no escrow fields", async () => {
    for (const [id, code, status] of [
      ["stream-kemi", "STREAM_NOT_CANCELLABLE", 422],
      ["stream-yusuf", "ALREADY_TERMINAL", 409],
    ] as const) {
      orgDb.streamOwnership.delete(id);
      db.streams.set(id, { ...db.streams.get(id)!, senderAddress: sender, ownership: "individual" });
      const response = await cancelStream(cancelRequest(id), context(id));
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
  });

  it("returns INVALID_ESCROW_STATE for released funds above vested funds", async () => {
    const id = await createActiveStream({ totalAmount: "2000000000", startTime: start, endTime: end });
    db.streams.set(id, { ...db.streams.get(id)!, releasedAmount: "600000000" });
    const response = await cancelStream(cancelRequest(id), context(id));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("INVALID_ESCROW_STATE");
    expect(db.streams.get(id)?.status).toBe("active");
  });

  it("keeps refund arithmetic exact above 2^53", async () => {
    const total = 9_007_199_254_740_993n;
    const id = await createActiveStream({ totalAmount: total.toString(), startTime: start, endTime: end });
    const response = await cancelStream(cancelRequest(id), context(id));
    expect(response.status).toBe(200);
    const { cancellation } = await response.json();
    expect(cancellation.recipientPayout).toBe((total / 4n).toString());
    expect(cancellation.senderRefund).toBe((total - total / 4n).toString());
  });
});
