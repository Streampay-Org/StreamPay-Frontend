import { POST as amendPost } from "./route";
import { POST as pausePost } from "../pause/route";
import { POST as approvePost } from "../approvals/[approvalId]/approve/route";
import { db, getStore } from "@/app/lib/db";
import { orgDb } from "@/app/lib/org-db";
import { DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import { eventBus } from "@/app/lib/event-bus";
import * as auditLogModule from "@/app/lib/audit-log";
import type { Stream } from "@/app/types/openapi";

const SENDER = "GSENDER11111111111111111111111111111111111111111111111111";
const OTHER = "GOTHER222222222222222222222222222222222222222222222222222";
const OWNER2 = "GOWNER222222222222222222222222222222222222222222222222222";
const RECIPIENT = "GRECIP333333333333333333333333333333333333333333333333333";

function futureIso(hoursAhead = 24): string {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

function pastIso(hoursAgo = 2): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function seedStream(overrides: Partial<Stream> = {}): Stream {
  const now = new Date().toISOString();
  const stream: Stream = {
    id: "stream-amend-1",
    recipient: RECIPIENT,
    senderAddress: SENDER,
    rate: "10",
    schedule: "Continuous",
    status: "active",
    token: "XLM",
    startTime: pastIso(1),
    endTime: futureIso(12),
    vestedAmount: "500000000",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  db.streams.set(stream.id, stream);
  return stream;
}

let ipCounter = 1;

function makeRequest(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  const ip = `10.0.0.${ipCounter++}`;
  return new Request(`http://localhost:3000/api/streams/${id}/amend`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/streams/[id]/amend", () => {
  beforeEach(() => {
    db.streams.clear();
    db.idempotency.clear();
    getStore().streamHistory.reset();
    orgDb.orgs.clear();
    orgDb.streamOwnership.clear();
    orgDb.approvals.clear();
    jest.restoreAllMocks();
  });

  it("amends an active stream's rate and end time, emits event, records history and audit", async () => {
    const stream = seedStream();
    const newEndsAt = futureIso(48);
    const emitSpy = jest.spyOn(eventBus, "emitStreamUpdated");

    const req = makeRequest(
      stream.id,
      { rate: "25", endsAt: newEndsAt },
      {
        "Idempotency-Key": "amend-key-1",
        "Actor-Wallet-Address": SENDER,
      },
    );

    const res = await amendPost(req, { params: Promise.resolve({ id: stream.id }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.rate).toBe("25");
    expect(json.data.endTime).toBe(newEndsAt);
    expect(json.data.status).toBe("active");

    // Persisted in store
    const stored = db.streams.get(stream.id)!;
    expect(stored.rate).toBe("25");
    expect(stored.endTime).toBe(newEndsAt);

    // History recorded
    const history = getStore().streamHistory.query({ streamId: stream.id, limit: 10 });
    expect(history.data.some((e) => e.type === "amended")).toBe(true);

    // Event bus emitted
    expect(emitSpy).toHaveBeenCalledWith(stream.id, expect.objectContaining({ rate: "25" }));

    // Audit recorded
    const auditEntries = auditLogModule.auditLogStore.list({ action: "stream.amend" });
    expect(auditEntries.some((e) => e.action === "stream.amend" && e.target.id === stream.id)).toBe(true);
  });

  it("replays cached response for the same Idempotency-Key without a second change", async () => {
    const stream = seedStream();
    const key = "amend-replay-key";

    const first = await amendPost(
      makeRequest(stream.id, { rate: "15" }, { "Idempotency-Key": key, "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const replay = await amendPost(
      makeRequest(stream.id, { rate: "15" }, { "Idempotency-Key": key, "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotency-Replay")).toBe("true");
    const replayJson = await replay.json();
    expect(replayJson).toEqual(firstJson);

    // Only one history event recorded
    const history = getStore().streamHistory.query({ streamId: stream.id, limit: 10 });
    expect(history.data.filter((e) => e.type === "amended")).toHaveLength(1);
  });

  it("returns 409 when reusing Idempotency-Key with a different body", async () => {
    const stream = seedStream();
    const key = "amend-conflict-key";

    const first = await amendPost(
      makeRequest(stream.id, { rate: "15" }, { "Idempotency-Key": key, "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(first.status).toBe(200);

    const conflict = await amendPost(
      makeRequest(stream.id, { rate: "99" }, { "Idempotency-Key": key, "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(conflict.status).toBe(409);
    const json = await conflict.json();
    expect(json.error).toBe("IdempotencyKeyReused");
  });

  it("returns 400 when Idempotency-Key header is missing", async () => {
    const stream = seedStream();
    const res = await amendPost(
      makeRequest(stream.id, { rate: "15" }, { "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("IdempotencyKeyRequired");
  });

  test.each<Stream["status"]>(["ended", "withdrawn", "cancelled"])(
    "returns 409 ILLEGAL_TRANSITION for %s stream",
    async (status) => {
      const stream = seedStream({ id: `stream-${status}`, status });
      const res = await amendPost(
        makeRequest(stream.id, { rate: "20" }, { "Idempotency-Key": `k-${status}`, "Actor-Wallet-Address": SENDER }),
        { params: Promise.resolve({ id: stream.id }) },
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe("ILLEGAL_TRANSITION");
    },
  );

  it("returns 422 with field details for invalid values (non-positive rate, past end time, empty body, extra fields)", async () => {
    const stream = seedStream();

    // Non-positive rate
    const badRate = await amendPost(
      makeRequest(stream.id, { rate: "0" }, { "Idempotency-Key": "k-bad-rate", "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(badRate.status).toBe(422);
    const badRateJson = await badRate.json();
    expect(badRateJson.error.details.fields.rate).toBeDefined();

    // End time in the past
    const pastEnd = await amendPost(
      makeRequest(stream.id, { endsAt: pastIso(5) }, { "Idempotency-Key": "k-past-end", "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(pastEnd.status).toBe(422);
    const pastEndJson = await pastEnd.json();
    expect(pastEndJson.error.details.fields.endsAt).toBeDefined();

    // Empty body
    const empty = await amendPost(
      makeRequest(stream.id, {}, { "Idempotency-Key": "k-empty", "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(empty.status).toBe(422);

    // Extra unknown field (strict schema)
    const extra = await amendPost(
      makeRequest(stream.id, { rate: "10", unknown: true }, { "Idempotency-Key": "k-extra", "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(extra.status).toBe(422);
  });

  it("returns 403 for non-owner attempting to amend", async () => {
    const stream = seedStream();
    const res = await amendPost(
      makeRequest(stream.id, { rate: "20" }, { "Idempotency-Key": "k-non-owner", "Actor-Wallet-Address": OTHER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(403);
    expect(db.streams.get(stream.id)!.rate).toBe("10");
  });

  it("allows amending a paused stream and lowering rate below already accrued amount", async () => {
    const stream = seedStream({ status: "paused", rate: "100", vestedAmount: "5000000000" });
    const res = await amendPost(
      makeRequest(stream.id, { rate: "0.5" }, { "Idempotency-Key": "k-paused", "Actor-Wallet-Address": SENDER }),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.rate).toBe("0.5");
    expect(json.data.status).toBe("paused");
  });

  it("serializes concurrent amend and pause requests via the repository lock", async () => {
    const stream = seedStream({ status: "active", rate: "10" });
    const amendReq = makeRequest(
      stream.id,
      { rate: "30" },
      { "Idempotency-Key": "k-concurrent-amend", "Actor-Wallet-Address": SENDER },
    );
    const pauseReq = new Request(`http://localhost:3000/api/streams/${stream.id}/pause`, {
      method: "POST",
      headers: {
        "Idempotency-Key": "k-concurrent-pause",
        "Actor-Wallet-Address": SENDER,
        "X-Forwarded-For": `10.0.0.${ipCounter++}`,
      },
    });

    const [amendRes, pauseRes] = await Promise.all([
      amendPost(amendReq, { params: Promise.resolve({ id: stream.id }) }),
      pausePost(pauseReq, { params: Promise.resolve({ id: stream.id }) }),
    ]);

    expect(amendRes.status).toBe(200);
    expect(pauseRes.status).toBe(200);
    const finalStream = db.streams.get(stream.id)!;
    expect(finalStream.rate).toBe("30");
    expect(finalStream.status).toBe("paused");
  });

  it("returns 202 for org streams requiring approval and applies amendment when final vote meets threshold", async () => {
    const stream = seedStream({ id: "stream-org-1", rate: "10" });
    const now = new Date().toISOString();
    orgDb.orgs.set("org-1", {
      id: "org-1",
      name: "Acme Org",
      members: [
        { walletAddress: SENDER, role: "owner", addedAt: now },
        { walletAddress: OWNER2, role: "owner", addedAt: now },
      ],
      policy: { ...DEFAULT_STREAM_POLICY, requireApprovals: 2 },
      createdAt: now,
      updatedAt: now,
    });
    orgDb.streamOwnership.set(stream.id, "org-1");

    const newEndsAt = futureIso(72);
    const amendRes = await amendPost(
      makeRequest(
        stream.id,
        { rate: "42", endsAt: newEndsAt },
        { "Idempotency-Key": "k-org-amend", "Actor-Wallet-Address": SENDER },
      ),
      { params: Promise.resolve({ id: stream.id }) },
    );

    expect(amendRes.status).toBe(202);
    const amendJson = await amendRes.json();
    expect(amendJson.data.action).toBe("amend");
    expect(amendJson.data.status).toBe("pending");
    expect(amendJson.data.payload).toEqual({ rate: "42", endsAt: newEndsAt });

    // Stream must NOT have changed yet
    expect(db.streams.get(stream.id)!.rate).toBe("10");

    // Second owner casts final approval vote
    const approvalId = amendJson.data.id;
    const approveReq = new Request(
      `http://localhost:3000/api/streams/${stream.id}/approvals/${approvalId}/approve`,
      {
        method: "POST",
        headers: { "Actor-Wallet-Address": OWNER2 },
      },
    );
    const approveRes = await approvePost(approveReq, {
      params: Promise.resolve({ id: stream.id, approvalId }),
    });
    expect(approveRes.status).toBe(200);
    const approveJson = await approveRes.json();
    expect(approveJson.meta.thresholdMet).toBe(true);
    expect(approveJson.data.status).toBe("approved");

    // Stream is now amended
    const updated = db.streams.get(stream.id)!;
    expect(updated.rate).toBe("42");
    expect(updated.endTime).toBe(newEndsAt);
  });
});
