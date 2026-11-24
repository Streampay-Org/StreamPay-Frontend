/**
 * @jest-environment node
 *
 * Tests for GET /api/streams/:id/history
 *
 * Test plan rows covered:
 *   #1  4 entries in correct commit order
 *   #2  Idempotent entry → no duplicate appended
 *   #3  Failed lifecycle call → no history entry
 *   #4  Pagination: 3 pages over 5 entries, no duplicates
 *   #5  Wrong tenant → 404
 *   #6  New stream → empty response (no events yet)
 *   #9  Entry payload contains no PII fields
 */

import { GET } from "./route";
import { db, getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetOrgDbForTesting } from "@/app/lib/org-db";

const TENANT = "tenant-test";

// ── helpers ───────────────────────────────────────────────────────────────────

function histReq(id: string, overrides: Record<string, string> = {}, tenant = TENANT): Request {
  const url = new URL(`http://localhost/api/streams/${id}/history`);
  for (const [k, v] of Object.entries(overrides)) url.searchParams.set(k, v);
  return new Request(url.toString(), { headers: { "x-tenant-id": tenant } });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Seed a stream with a `tenant` field so `db.streams.findOne(tenant, id)` works.
 * The seeded in-memory fixtures don't have a tenant field; this helper adds one.
 */
function seedStream(id: string, tenantId = TENANT) {
  db.streams.set(id, {
    id,
    recipient: "Test Recipient",
    rate: "10 XLM / month",
    schedule: "monthly",
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
    status: "active",
    nextAction: "pause",
    token: "XLM",
    tenant: tenantId,
  } as any);
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  _resetOrgDbForTesting();
});

// ── tenant validation ─────────────────────────────────────────────────────────

describe("tenant header validation", () => {
  it("returns 400 MISSING_TENANT when header is absent", async () => {
    const req = new Request("http://localhost/api/streams/stream-ada/history");
    const res = await GET(req, ctx("stream-ada"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("MISSING_TENANT");
  });

  it("returns 400 MISSING_TENANT when header is blank", async () => {
    const req = new Request("http://localhost/api/streams/stream-ada/history", {
      headers: { "x-tenant-id": "  " },
    });
    const res = await GET(req, ctx("stream-ada"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("MISSING_TENANT");
  });
});

// ── stream not found / wrong tenant (test #5) ─────────────────────────────────

describe("stream visibility", () => {
  it("returns 404 for unknown stream id", async () => {
    const res = await GET(histReq("no-such-stream"), ctx("no-such-stream"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 404 for stream owned by a different tenant (test #5)", async () => {
    seedStream("stream-x", "tenant-a");
    const res = await GET(histReq("stream-x", {}, "tenant-b"), ctx("stream-x"));
    expect(res.status).toBe(404);
  });

  it("returns 200 for the correct tenant", async () => {
    seedStream("stream-x");
    const res = await GET(histReq("stream-x"), ctx("stream-x"));
    expect(res.status).toBe(200);
  });
});

// ── limit validation ──────────────────────────────────────────────────────────

describe("limit query parameter", () => {
  beforeEach(() => seedStream("stream-v"));

  it("returns 422 for limit=0", async () => {
    const res = await GET(histReq("stream-v", { limit: "0" }), ctx("stream-v"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 for limit=101", async () => {
    const res = await GET(histReq("stream-v", { limit: "101" }), ctx("stream-v"));
    expect(res.status).toBe(422);
  });

  it("returns 422 for non-numeric limit", async () => {
    const res = await GET(histReq("stream-v", { limit: "abc" }), ctx("stream-v"));
    expect(res.status).toBe(422);
  });

  it("uses default limit=20 when not supplied", async () => {
    const store = getStore().streamHistory;
    for (let i = 0; i < 25; i++) {
      store.append({
        id: `def${i}`,
        streamId: "stream-v",
        type: "paused",
        toStatus: "paused",
        at: `2026-06-01T${String(i).padStart(2, "0")}:00:00.000Z`,
      });
    }
    const res = await GET(histReq("stream-v"), ctx("stream-v"));
    const body = await res.json();
    expect(body.data).toHaveLength(20);
    expect(body.meta.nextCursor).not.toBeNull();
  });
});

// ── empty state (test #6) ─────────────────────────────────────────────────────

describe("empty stream history (test #6)", () => {
  it("returns empty data and null nextCursor for a stream with no events", async () => {
    seedStream("stream-new");
    const res = await GET(histReq("stream-new"), ctx("stream-new"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.nextCursor).toBeNull();
  });
});

// ── ordering (test #1) ────────────────────────────────────────────────────────

describe("commit-order entries (test #1)", () => {
  it("returns 4 entries newest-first for create→start→pause→resume", async () => {
    seedStream("stream-lifecycle");
    const store = getStore().streamHistory;
    store.append({ id: "h1", streamId: "stream-lifecycle", type: "created",  toStatus: "draft",   at: "2026-06-01T09:00:00.000Z" });
    store.append({ id: "h2", streamId: "stream-lifecycle", type: "started",  toStatus: "active",  at: "2026-06-01T09:01:00.000Z" });
    store.append({ id: "h3", streamId: "stream-lifecycle", type: "paused",   toStatus: "paused",  at: "2026-06-01T09:02:00.000Z" });
    store.append({ id: "h4", streamId: "stream-lifecycle", type: "resumed",  toStatus: "active",  at: "2026-06-01T09:03:00.000Z" });

    const body = await (await GET(histReq("stream-lifecycle"), ctx("stream-lifecycle"))).json();
    expect(body.data).toHaveLength(4);
    expect(body.data.map((e: any) => e.type)).toEqual(["resumed", "paused", "started", "created"]);
  });
});

// ── idempotency guard (test #2) ───────────────────────────────────────────────

describe("idempotency guard (test #2)", () => {
  it("duplicate entry id does not create a second entry", () => {
    const store = getStore().streamHistory;
    const e = { id: "idem-1", streamId: "s", type: "paused" as const, toStatus: "paused", at: "2026-06-01T10:00:00.000Z" };
    store.append(e);
    store.append(e);
    expect(store.query({ streamId: "s", limit: 10 }).data).toHaveLength(1);
  });
});

// ── failed lifecycle → no history entry (test #3) ───────────────────────────

describe("failed lifecycle call leaves no entry (test #3)", () => {
  it("pausing a draft stream does not append an entry", async () => {
    // stream-kemi is 'draft' in the seeded store; pause requires 'active'
    const id = "stream-kemi";
    const store = getStore().streamHistory;
    const before = store.query({ streamId: id, limit: 100 }).data.length;

    const { POST: pauseStream } = await import("@/app/api/streams/[id]/pause/route");
    const res = await pauseStream(
      new Request(`http://localhost/api/streams/${id}/pause`, { method: "POST" }),
      ctx(id),
    );
    expect(res.status).toBe(409); // INVALID_STREAM_STATE

    expect(store.query({ streamId: id, limit: 100 }).data.length).toBe(before);
  });
});

// ── pagination (test #4) ──────────────────────────────────────────────────────

describe("pagination 3 pages over 5 entries (test #4)", () => {
  it("no duplicates, correct page boundaries", async () => {
    seedStream("stream-pg");
    const store = getStore().streamHistory;
    for (let i = 1; i <= 5; i++) {
      store.append({
        id: `p${i}`,
        streamId: "stream-pg",
        type: "paused",
        toStatus: "paused",
        at: `2026-06-0${i}T10:00:00.000Z`,
      });
    }

    const p1 = await (await GET(histReq("stream-pg", { limit: "2" }), ctx("stream-pg"))).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.meta.nextCursor).not.toBeNull();

    const p2 = await (await GET(histReq("stream-pg", { limit: "2", cursor: p1.meta.nextCursor }), ctx("stream-pg"))).json();
    expect(p2.data).toHaveLength(2);
    expect(p2.meta.nextCursor).not.toBeNull();

    const p3 = await (await GET(histReq("stream-pg", { limit: "2", cursor: p2.meta.nextCursor }), ctx("stream-pg"))).json();
    expect(p3.data).toHaveLength(1);
    expect(p3.meta.nextCursor).toBeNull();

    const allIds = [...p1.data, ...p2.data, ...p3.data].map((e: any) => e.id);
    expect(new Set(allIds).size).toBe(5);
  });
});

// ── no PII (test #9) ──────────────────────────────────────────────────────────

describe("no PII in entry payload (test #9)", () => {
  it("actor is at most 6 chars and no email/label/memo field", () => {
    const store = getStore().streamHistory;
    store.append({
      id: "pii-check",
      streamId: "s-pii",
      type: "paused",
      toStatus: "paused",
      at: "2026-06-01T10:00:00.000Z",
      actor: "GABCDE",
    });
    const { data } = store.query({ streamId: "s-pii", limit: 10 });
    const e = data[0];
    expect(e.actor!.length).toBeLessThanOrEqual(6);
    expect(e).not.toHaveProperty("email");
    expect(e).not.toHaveProperty("label");
    expect(e).not.toHaveProperty("memo");
  });
});
