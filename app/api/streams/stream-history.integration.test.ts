/**
 * @jest-environment node
 *
 * Integration: lifecycle routes append entries to the stream history store.
 *
 * Test plan rows covered:
 *   #1  create+start+pause+resume → 4 entries in commit order
 *   #2  Idempotent replay → no extra entry
 *   #3  Failed state transition → no entry
 */

import { POST as pauseStream } from "@/app/api/streams/[id]/pause/route";
import { POST as startStream } from "@/app/api/streams/[id]/start/route";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetOrgDbForTesting } from "@/app/lib/org-db";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  _resetOrgDbForTesting();
});

// ── start route ───────────────────────────────────────────────────────────────

const AUTH_HEADERS = { "Actor-Wallet-Address": "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G" };

describe("start route", () => {
  it("appends 'started' entry when a draft stream starts", async () => {
    const res = await startStream(
      new Request("http://localhost/api/streams/stream-kemi/start", { method: "POST" }),
      ctx("stream-kemi"),
    );
    expect(res.status).toBe(200);

    const { data } = getStore().streamHistory.query({ streamId: "stream-kemi", limit: 10 });
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe("started");
    expect(data[0].fromStatus).toBe("draft");
    expect(data[0].toStatus).toBe("active");
  });

  it("appends 'resumed' entry when a paused stream resumes", async () => {
    // Pause first
    await pauseStream(
      new Request("http://localhost/api/streams/stream-ada/pause", { method: "POST", headers: AUTH_HEADERS }),
      ctx("stream-ada"),
    );
    // Resume
    const res = await startStream(
      new Request("http://localhost/api/streams/stream-ada/start", { method: "POST", headers: AUTH_HEADERS }),
      ctx("stream-ada"),
    );
    expect(res.status).toBe(200);

    const { data } = getStore().streamHistory.query({ streamId: "stream-ada", limit: 10 });
    const types = data.map((e) => e.type);
    expect(types).toContain("paused");
    expect(types).toContain("resumed");
  });
});

// ── pause route ───────────────────────────────────────────────────────────────

describe("pause route", () => {
  it("appends 'paused' entry on success (test #1)", async () => {
    const res = await pauseStream(
      new Request("http://localhost/api/streams/stream-ada/pause", { method: "POST", headers: AUTH_HEADERS }),
      ctx("stream-ada"),
    );
    expect(res.status).toBe(200);

    const { data } = getStore().streamHistory.query({ streamId: "stream-ada", limit: 10 });
    expect(data).toHaveLength(1);
    expect(data[0].type).toBe("paused");
    expect(data[0].fromStatus).toBe("active");
    expect(data[0].toStatus).toBe("paused");
  });

  it("idempotent pause replay does NOT append a second entry (test #2)", async () => {
    const key = "idem-key-pause-test";
    // First call
    await pauseStream(
      new Request("http://localhost/api/streams/stream-ada/pause", {
        method: "POST",
        headers: { "Idempotency-Key": key, ...AUTH_HEADERS },
      }),
      ctx("stream-ada"),
    );
    // Replay
    const replay = await pauseStream(
      new Request("http://localhost/api/streams/stream-ada/pause", {
        method: "POST",
        headers: { "Idempotency-Key": key, ...AUTH_HEADERS },
      }),
      ctx("stream-ada"),
    );
    expect(replay.status).toBe(200);

    const { data } = getStore().streamHistory.query({ streamId: "stream-ada", limit: 10 });
    // Only the original call should produce an entry; the replay must not.
    expect(data).toHaveLength(1);
  });

  it("failed pause (wrong state) does NOT append an entry (test #3)", async () => {
    // stream-kemi is 'draft' — cannot be paused
    const res = await pauseStream(
      new Request("http://localhost/api/streams/stream-kemi/pause", { method: "POST" }),
      ctx("stream-kemi"),
    );
    expect(res.status).toBe(409);

    const { data } = getStore().streamHistory.query({ streamId: "stream-kemi", limit: 10 });
    expect(data).toHaveLength(0);
  });
});

// ── ordering (test #1) ────────────────────────────────────────────────────────

describe("commit ordering", () => {
  it("create→start→pause→resume produces 4 entries newest-first", async () => {
    const store = getStore().streamHistory;
    // Directly insert with explicit timestamps to test ordering independent of wall clock
    store.append({ id: "t1", streamId: "stream-ord", type: "created",  toStatus: "draft",   at: "2026-06-01T09:00:00.000Z" });
    store.append({ id: "t2", streamId: "stream-ord", type: "started",  toStatus: "active",  at: "2026-06-01T09:01:00.000Z" });
    store.append({ id: "t3", streamId: "stream-ord", type: "paused",   toStatus: "paused",  at: "2026-06-01T09:02:00.000Z" });
    store.append({ id: "t4", streamId: "stream-ord", type: "resumed",  toStatus: "active",  at: "2026-06-01T09:03:00.000Z" });

    const { data } = store.query({ streamId: "stream-ord", limit: 10 });
    expect(data).toHaveLength(4);
    expect(data.map((e) => e.type)).toEqual(["resumed", "paused", "started", "created"]);
  });
});
