import { GET as previewCancel } from "./route";
import { POST as cancelStream } from "../route";
import { db, getStore, resetDb } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { signToken } from "@/app/lib/auth";
import { auditLogStore } from "@/app/lib/audit-log";
import { webhookOutboxStore } from "@/app/lib/webhook-outbox";
import type { Stream } from "@/app/types/openapi";

const FIXED_NOW = new Date("2026-01-01T06:00:00.000Z");

jest.mock("@/app/lib/escrow-state", () => ({
  ...jest.requireActual("@/app/lib/escrow-state"),
  escrowNow: () => FIXED_NOW,
}));

const SENDER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const RECIPIENT = "GBBQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-cancel-preview",
    recipient: RECIPIENT,
    senderAddress: SENDER,
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

function authHeaders(wallet: string = SENDER, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${signToken(wallet)}`,
    ...extra,
  };
}

describe("GET /api/streams/[id]/cancel/preview", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    orgDb.orgs.clear();
    orgDb.streamOwnership.clear();
  });

  it("matches POST /cancel amounts, preserves escrow invariant, sets Cache-Control: no-store, and does not mutate", async () => {
    const stream = makeStream();
    db.streams.set(stream.id, stream);

    const auditBefore = auditLogStore.count();
    const outboxBefore = webhookOutboxStore.getAllOutboxEntries().length;

    const previewRes = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );

    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get("Cache-Control")).toBe("no-store");

    const { data } = await previewRes.json();
    expect(data.action).toBe("cancel");
    expect(data.allowed).toBe(true);
    expect(data.currentStatus).toBe("active");
    expect(data.nextStatus).toBe("cancelled");

    // Escrow invariant: recipientPayout + senderRefund === total - released
    expect(BigInt(data.recipientPayout) + BigInt(data.senderRefund)).toBe(
      BigInt(data.totalAmount) - BigInt(data.releasedAmount),
    );

    // No side effects: stream unchanged, no history, no audit, no outbox
    expect(db.streams.get(stream.id)?.status).toBe("active");
    expect(getStore().streamHistory.query({ streamId: stream.id, limit: 10 }).data).toHaveLength(0);
    expect(auditLogStore.count()).toBe(auditBefore);
    expect(webhookOutboxStore.getAllOutboxEntries().length).toBe(outboxBefore);

    // Compare with actual POST /cancel at the same timestamp
    const postRes = await cancelStream(
      new Request(`http://localhost/api/streams/${stream.id}/cancel`, {
        method: "POST",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(postRes.status).toBe(200);
    const { cancellation } = await postRes.json();
    expect(data.recipientPayout).toBe(cancellation.recipientPayout);
    expect(data.senderRefund).toBe(cancellation.senderRefund);
  });

  it("handles paused stream clamped to pausedAt", async () => {
    const stream = makeStream({
      status: "paused",
      pausedAt: "2026-01-01T03:00:00.000Z",
    });
    db.streams.set(stream.id, stream);

    const res = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.vestedAmount).toBe("250000000");
    expect(data.recipientPayout).toBe("150000000");
    expect(data.senderRefund).toBe("1750000000");
  });

  it("handles stream at exactly endTime (zero sender refund)", async () => {
    const stream = makeStream({
      endTime: FIXED_NOW.toISOString(),
    });
    db.streams.set(stream.id, stream);

    const res = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.senderRefund).toBe("0");
    expect(data.recipientPayout).toBe("1900000000");
  });

  it("handles bigint amounts above Number.MAX_SAFE_INTEGER without precision loss", async () => {
    const hugeTotal = "9007199254740993000000";
    const hugeReleased = "1000000000000000000000";
    const stream = makeStream({
      totalAmount: hugeTotal,
      releasedAmount: hugeReleased,
    });
    db.streams.set(stream.id, stream);

    const res = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(BigInt(data.recipientPayout) + BigInt(data.senderRefund)).toBe(
      BigInt(hugeTotal) - BigInt(hugeReleased),
    );
  });

  it("returns 404 for unknown stream", async () => {
    const res = await previewCancel(
      new Request("http://localhost/api/streams/missing/cancel/preview", {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 409 for draft and terminal streams", async () => {
    for (const status of ["draft", "cancelled", "ended", "withdrawn"] as const) {
      const stream = makeStream({ id: `stream-${status}`, status });
      db.streams.set(stream.id, stream);

      const res = await previewCancel(
        new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
          method: "GET",
          headers: authHeaders(),
        }),
        { params: Promise.resolve({ id: stream.id }) },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("ILLEGAL_TRANSITION");
    }
  });

  it("returns 422 when escrow state is unknown", async () => {
    const stream = makeStream({ totalAmount: undefined });
    db.streams.set(stream.id, stream);

    const res = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("ESCROW_STATE_UNAVAILABLE");
  });

  it("returns 403 when caller is not the sender", async () => {
    const stream = makeStream();
    db.streams.set(stream.id, stream);

    const res = await previewCancel(
      new Request(`http://localhost/api/streams/${stream.id}/cancel/preview`, {
        method: "GET",
        headers: authHeaders(RECIPIENT),
      }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("SENDER_AUTH_REQUIRED");
  });
});
