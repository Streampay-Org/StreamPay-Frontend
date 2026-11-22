/** @jest-environment node */

import { POST } from "./route";
import { resetConfigCache } from "@/app/lib/config";
import { db, getStore, resetDb } from "@/app/lib/db";
import { createInternalServiceRequestHeaders } from "@/app/lib/internal-service-auth";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";
import { webhookOutboxStore } from "@/app/lib/webhook-outbox";
import type { Stream } from "@/app/types/openapi";

const URL = "http://localhost/api/internal/jobs/settle-ended";
const keys = { current: "a".repeat(32), next: "b".repeat(32) };

function authedRequest(body = "", serviceName = "ops-automation"): Request {
  const headers = createInternalServiceRequestHeaders({
    body,
    keyId: "current",
    method: "POST",
    secret: keys.current,
    serviceName,
    url: URL,
  });
  return new Request(URL, { method: "POST", headers, body });
}

function makeStream(overrides: Partial<Stream> & { id: string; status: Stream["status"] }): Stream {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    senderAddress: "GSENDER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    recipient: "GRECIPIENT1234567890ABCDEFGHIJKLMNOPQRSTUVW",
    token: "USDC",
    amount: "1000",
    ratePerSecond: "1",
    status: overrides.status,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Stream;
}

describe("POST /api/internal/jobs/settle-ended", () => {
  beforeEach(() => {
    resetConfigCache();
    resetDb();
    resetAuditLogStore();
    webhookOutboxStore.clear();
    globalThis.__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = undefined;

    process.env.STELLAR_NETWORK = "testnet";
    process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
    process.env.ALLOWED_ORIGINS = "http://localhost:3000";
    process.env.INTERNAL_SERVICE_HMAC_KEYS = JSON.stringify(keys);
    process.env.INTERNAL_SERVICE_CURRENT_KEY_ID = "current";
    process.env.INTERNAL_SERVICE_CLOCK_SKEW_SECONDS = "300";
  });

  afterEach(() => {
    globalThis.__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = undefined;
  });

  it("conceals the route as 404 for unauthenticated callers", async () => {
    const res = await POST(new Request(URL, { method: "POST" }));
    expect(res.status).toBe(404);
  });

  it("conceals the route as 404 for disallowed internal services", async () => {
    const res = await POST(authedRequest("", "cleanup-worker"));
    expect(res.status).toBe(404);
  });

  it("allows both ops-automation and settle-worker services", async () => {
    const resOps = await POST(authedRequest("", "ops-automation"));
    expect(resOps.status).toBe(200);

    const resWorker = await POST(authedRequest("", "settle-worker"));
    expect(resWorker.status).toBe(200);
  });

  it("settles only active and paused streams past endTime and leaves others untouched", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const store = getStore().streamRepository.streams;
    store.set("active-past", makeStream({ id: "active-past", status: "active", endTime: past, webhook_url: "https://example.com/hook" }));
    store.set("paused-past", makeStream({ id: "paused-past", status: "paused", endTime: past }));
    store.set("active-future", makeStream({ id: "active-future", status: "active", endTime: future }));
    store.set("active-no-end", makeStream({ id: "active-no-end", status: "active" }));
    store.set("active-bad-end", makeStream({ id: "active-bad-end", status: "active", endTime: "not-a-date" }));
    store.set("draft-past", makeStream({ id: "draft-past", status: "draft", endTime: past }));
    store.set("cancelled-past", makeStream({ id: "cancelled-past", status: "cancelled", endTime: past }));
    store.set("ended-past", makeStream({ id: "ended-past", status: "ended", endTime: past }));
    store.set("withdrawn-past", makeStream({ id: "withdrawn-past", status: "withdrawn", endTime: past }));

    const res = await POST(authedRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      scanned: 9,
      eligible: 2,
      processed: 2,
      settled: 2,
      skipped: 0,
      failed: 0,
      failedStreamIds: [],
      dryRun: false,
      limit: 100,
    });

    expect(db.streams.get("active-past").status).toBe("ended");
    expect(db.streams.get("paused-past").status).toBe("ended");
    expect(db.streams.get("active-future").status).toBe("active");
    expect(db.streams.get("active-no-end").status).toBe("active");
    expect(db.streams.get("active-bad-end").status).toBe("active");
    expect(db.streams.get("draft-past").status).toBe("draft");
    expect(db.streams.get("cancelled-past").status).toBe("cancelled");
    expect(db.streams.get("ended-past").status).toBe("ended");
    expect(db.streams.get("withdrawn-past").status).toBe("withdrawn");

    // Verify history, audit, and webhook side effects match manual settle
    const historyActive = getStore().streamHistory.query({ streamId: "active-past" }).data;
    expect(historyActive.some((e) => e.type === "settled" && e.toStatus === "ended")).toBe(true);

    const historyPaused = getStore().streamHistory.query({ streamId: "paused-past" }).data;
    expect(historyPaused.some((e) => e.type === "settled" && e.fromStatus === "paused" && e.toStatus === "ended")).toBe(true);

    const auditEntries = auditLogStore.list({ action: "stream.settle" });
    expect(auditEntries.map((e) => e.target.id).sort()).toEqual(["active-past", "paused-past"]);

    const outbox = webhookOutboxStore.getAllOutboxEntries();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].streamId).toBe("active-past");
    expect(outbox[0].eventType).toBe("stream.settled");
  });

  it("supports dryRun without mutating streams, history, audit, or webhooks", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = getStore().streamRepository.streams;
    store.set("active-past", makeStream({ id: "active-past", status: "active", endTime: past, webhook_url: "https://example.com/hook" }));

    const res = await POST(authedRequest(JSON.stringify({ dryRun: true })));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      scanned: 1,
      eligible: 1,
      processed: 1,
      settled: 0,
      skipped: 0,
      failed: 0,
      candidates: ["active-past"],
      dryRun: true,
    });

    expect(db.streams.get("active-past").status).toBe("active");
    expect(getStore().streamHistory.query({ streamId: "active-past" }).data).toHaveLength(0);
    expect(auditLogStore.list({ action: "stream.settle" })).toHaveLength(0);
    expect(webhookOutboxStore.getAllOutboxEntries()).toHaveLength(0);
  });

  it("is idempotent when re-run", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    getStore().streamRepository.streams.set("s1", makeStream({ id: "s1", status: "active", endTime: past }));

    const first = await POST(authedRequest(""));
    expect(first.status).toBe(200);
    expect((await first.json()).settled).toBe(1);

    const second = await POST(authedRequest(""));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.eligible).toBe(0);
    expect(secondBody.settled).toBe(0);
    expect(secondBody.failed).toBe(0);
  });

  it("respects limit and rejects limit above max (500)", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = getStore().streamRepository.streams;
    store.set("s1", makeStream({ id: "s1", status: "active", endTime: past }));
    store.set("s2", makeStream({ id: "s2", status: "active", endTime: past }));
    store.set("s3", makeStream({ id: "s3", status: "active", endTime: past }));

    const res = await POST(authedRequest(JSON.stringify({ limit: 2 })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(3);
    expect(body.processed).toBe(2);
    expect(body.settled).toBe(2);

    const tooHigh = await POST(authedRequest(JSON.stringify({ limit: 501 })));
    expect(tooHigh.status).toBe(400);
    expect((await tooHigh.json()).error.code).toBe("INVALID_REQUEST");

    const invalidDryRun = await POST(authedRequest(JSON.stringify({ dryRun: "yes" })));
    expect(invalidDryRun.status).toBe(400);
  });

  it("skips a failing stream and continues settling remaining streams", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const store = getStore().streamRepository.streams;
    store.set("s-fail", makeStream({ id: "s-fail", status: "active", endTime: past }));
    store.set("s-ok", makeStream({ id: "s-ok", status: "active", endTime: past }));

    globalThis.__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
      async settleStream({ streamId }) {
        if (streamId === "s-fail") {
          throw new Error("Simulated Soroban RPC error");
        }
        return { settledAt: new Date().toISOString(), txHash: "tx-ok-123" };
      },
    };

    const res = await POST(authedRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.settled).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failedStreamIds).toEqual(["s-fail"]);

    // Failed stream stays active so a later retry can pick it up
    expect(db.streams.get("s-fail").status).toBe("active");
    expect(db.streams.get("s-ok").status).toBe("ended");
  });
});
