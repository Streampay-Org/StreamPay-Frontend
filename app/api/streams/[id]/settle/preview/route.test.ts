import { GET as previewSettle } from "./route";
import { db, getStore, resetDb } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { signToken } from "@/app/lib/auth";
import { auditLogStore } from "@/app/lib/audit-log";
import type { Stream } from "@/app/types/openapi";

const FIXED_NOW = new Date("2026-01-01T06:00:00.000Z");

jest.mock("@/app/lib/escrow-state", () => ({
  ...jest.requireActual("@/app/lib/escrow-state"),
  escrowNow: () => FIXED_NOW,
}));

const ACTOR = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const RECIPIENT = "GBBQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-settle-preview",
    recipient: RECIPIENT,
    senderAddress: ACTOR,
    ownership: "individual",
    rate: "1",
    schedule: "day",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    token: "XLM",
    totalAmount: "2000000000",
    releasedAmount: "100000000",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function authHeaders(wallet: string = ACTOR) {
  return { Authorization: `Bearer ${signToken(wallet)}` };
}

describe("GET /api/streams/[id]/settle/preview", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    orgDb.orgs.clear();
    orgDb.streamOwnership.clear();
  });

  it("computes settle preview with Cache-Control: no-store and no mutations", async () => {
    const stream = makeStream();
    db.streams.set(stream.id, stream);

    const auditBefore = auditLogStore.count();

    const res = await previewSettle(
      new Request(`http://localhost/api/streams/${stream.id}/settle/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const { data } = await res.json();
    expect(data.action).toBe("settle");
    expect(data.allowed).toBe(true);
    expect(data.currentStatus).toBe("active");
    expect(data.nextStatus).toBe("ended");
    expect(data.vestedAmount).toBe("500000000");
    expect(data.withdrawableAmount).toBe("400000000");
    expect(data.unvestedAmount).toBe("1500000000");

    // No side effects
    expect(db.streams.get(stream.id)?.status).toBe("active");
    expect(getStore().streamHistory.query({ streamId: stream.id, limit: 10 }).data).toHaveLength(0);
    expect(auditLogStore.count()).toBe(auditBefore);
  });

  it("handles paused stream and stream at exactly endTime", async () => {
    const paused = makeStream({
      id: "stream-paused",
      status: "paused",
      pausedAt: "2026-01-01T03:00:00.000Z",
    });
    db.streams.set(paused.id, paused);

    const pausedRes = await previewSettle(
      new Request(`http://localhost/api/streams/${paused.id}/settle/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: paused.id }) },
    );
    expect(pausedRes.status).toBe(200);
    expect((await pausedRes.json()).data.vestedAmount).toBe("250000000");

    const atEnd = makeStream({
      id: "stream-at-end",
      endTime: FIXED_NOW.toISOString(),
    });
    db.streams.set(atEnd.id, atEnd);

    const endRes = await previewSettle(
      new Request(`http://localhost/api/streams/${atEnd.id}/settle/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: atEnd.id }) },
    );
    expect(endRes.status).toBe(200);
    expect((await endRes.json()).data.unvestedAmount).toBe("0");
  });

  it("returns 404 for unknown stream", async () => {
    const res = await previewSettle(
      new Request("http://localhost/api/streams/missing/settle/preview", {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 409 for draft, cancelled, and withdrawn streams", async () => {
    for (const status of ["draft", "cancelled", "withdrawn"] as const) {
      const stream = makeStream({ id: `stream-${status}`, status });
      db.streams.set(stream.id, stream);

      const res = await previewSettle(
        new Request(`http://localhost/api/streams/${stream.id}/settle/preview`, {
          method: "GET",
          headers: authHeaders(),
        }),
        { params: Promise.resolve({ id: stream.id }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("returns 422 when escrow state is unknown", async () => {
    const stream = makeStream({ totalAmount: undefined });
    db.streams.set(stream.id, stream);

    const res = await previewSettle(
      new Request(`http://localhost/api/streams/${stream.id}/settle/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("ESCROW_STATE_UNAVAILABLE");
  });
});
