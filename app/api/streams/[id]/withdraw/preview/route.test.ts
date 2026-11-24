import { GET as previewWithdraw } from "./route";
import { db, getStore, resetDb } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { signToken } from "@/app/lib/auth";
import { auditLogStore } from "@/app/lib/audit-log";
import type { Stream } from "@/app/types/openapi";

const FIXED_NOW = new Date("2026-01-02T00:00:00.000Z");

jest.mock("@/app/lib/escrow-state", () => ({
  ...jest.requireActual("@/app/lib/escrow-state"),
  escrowNow: () => FIXED_NOW,
}));

const SENDER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const RECIPIENT = "GBBQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-withdraw-preview",
    recipient: RECIPIENT,
    senderAddress: SENDER,
    ownership: "individual",
    rate: "1",
    schedule: "day",
    status: "ended",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    token: "XLM",
    totalAmount: "2000000000",
    releasedAmount: "500000000",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function authHeaders(wallet: string = RECIPIENT) {
  return { Authorization: `Bearer ${signToken(wallet)}` };
}

describe("GET /api/streams/[id]/withdraw/preview", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    orgDb.orgs.clear();
    orgDb.streamOwnership.clear();
  });

  it("computes full withdraw preview with Cache-Control: no-store and no mutations", async () => {
    const stream = makeStream();
    db.streams.set(stream.id, stream);

    const auditBefore = auditLogStore.count();

    const res = await previewWithdraw(
      new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const { data } = await res.json();
    expect(data.action).toBe("withdraw");
    expect(data.allowed).toBe(true);
    expect(data.currentStatus).toBe("ended");
    expect(data.nextStatus).toBe("withdrawn");
    expect(data.amountPaidOut).toBe("1500000000");
    expect(data.newReleasedAmount).toBe("2000000000");
    expect(data.remainingEscrow).toBe("0");

    // No side effects
    expect(db.streams.get(stream.id)?.releasedAmount).toBe("500000000");
    expect(getStore().streamHistory.query({ streamId: stream.id, limit: 10 }).data).toHaveLength(0);
    expect(auditLogStore.count()).toBe(auditBefore);
  });

  it("supports partial withdrawal via ?amount query param and bigint above MAX_SAFE_INTEGER", async () => {
    const hugeTotal = "9007199254740995000000";
    const hugeReleased = "1000000000000000000000";
    const partial = "2500000000000000000000";
    const stream = makeStream({
      totalAmount: hugeTotal,
      releasedAmount: hugeReleased,
    });
    db.streams.set(stream.id, stream);

    const res = await previewWithdraw(
      new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview?amount=${partial}`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.amountPaidOut).toBe(partial);
    expect(data.newReleasedAmount).toBe((BigInt(hugeReleased) + BigInt(partial)).toString());
  });

  it("returns 409 for draft, active, paused, cancelled, and fully withdrawn streams", async () => {
    for (const status of ["draft", "active", "paused", "cancelled", "withdrawn"] as const) {
      const stream = makeStream({ id: `stream-${status}`, status });
      db.streams.set(stream.id, stream);

      const res = await previewWithdraw(
        new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview`, {
          method: "GET",
          headers: authHeaders(),
        }),
        { params: Promise.resolve({ id: stream.id }) },
      );
      expect(res.status).toBe(409);
    }
  });

  it("returns 404 for unknown stream", async () => {
    const res = await previewWithdraw(
      new Request("http://localhost/api/streams/missing/withdraw/preview", {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 401 when unauthenticated and 403 when caller is not recipient", async () => {
    const stream = makeStream();
    db.streams.set(stream.id, stream);

    const unauth = await previewWithdraw(
      new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview`, { method: "GET" }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(unauth.status).toBe(401);

    const wrongCaller = await previewWithdraw(
      new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview`, {
        method: "GET",
        headers: authHeaders(SENDER),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(wrongCaller.status).toBe(403);
  });

  it("returns 422 when escrow state is unknown", async () => {
    const stream = makeStream({ totalAmount: undefined });
    db.streams.set(stream.id, stream);

    const res = await previewWithdraw(
      new Request(`http://localhost/api/streams/${stream.id}/withdraw/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_ESCROW_STATE");
  });
});
