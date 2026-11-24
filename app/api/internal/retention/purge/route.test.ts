/** @jest-environment node */

import { POST, RETENTION_PURGE_ACTION } from "./route";
import { resetConfigCache } from "@/app/lib/config";
import { db, getStore, resetDb } from "@/app/lib/db";
import { createInternalServiceRequestHeaders } from "@/app/lib/internal-service-auth";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";
import type { Stream } from "@/app/types/openapi";

const URL = "http://localhost/api/internal/retention/purge";
const keys = { current: "a".repeat(32) };
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

const OLD = new Date(Date.now() - 8 * YEAR_MS).toISOString();
const RECENT = new Date(Date.now() - 1 * YEAR_MS).toISOString();

function authedRequest(
  body = "",
  serviceName = "ops-automation",
  extraHeaders: Record<string, string> = {}
): Request {
  const headers = {
    ...createInternalServiceRequestHeaders({
      body,
      keyId: "current",
      method: "POST",
      secret: keys.current,
      serviceName,
      url: URL,
    }),
    ...extraHeaders,
  };
  return new Request(URL, { method: "POST", headers, body });
}

function makeStream(overrides: Partial<Stream> & { id: string }): Stream {
  return {
    id: overrides.id,
    recipient: "GRECIPIENT1234567890ABCDEFGHIJKLMNOPQRSTUVW",
    rate: "10 XLM / day",
    schedule: "daily",
    status: "active",
    token: "XLM",
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

function seed(stream: Stream): Stream {
  getStore().streamRepository.streams.set(stream.id, stream);
  return stream;
}

beforeEach(() => {
  resetConfigCache();
  resetDb();
  db.streams.clear();
  resetAuditLogStore();

  process.env.STELLAR_NETWORK = "testnet";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ALLOWED_ORIGINS = "http://localhost:3000";
  process.env.INTERNAL_SERVICE_HMAC_KEYS = JSON.stringify(keys);
  process.env.INTERNAL_SERVICE_CURRENT_KEY_ID = "current";
  process.env.INTERNAL_SERVICE_CLOCK_SKEW_SECONDS = "300";
});

describe("POST /api/internal/retention/purge", () => {
  it("conceals the route as 404 for unauthenticated callers", async () => {
    const res = await POST(new Request(URL, { method: "POST" }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "ROUTE_NOT_FOUND" },
    });
  });

  it("conceals the route as 404 for disallowed internal services", async () => {
    const res = await POST(authedRequest("", "cleanup-worker"));
    expect(res.status).toBe(404);
  });

  it("purges expired streams, keeps aggregates, and audits each purge", async () => {
    const old = seed(
      makeStream({
        id: "old",
        email: "old@example.test",
        label: "Old Label",
        memo: "Old memo",
        partnerId: "P-OLD",
        totalAmount: "3600",
        vestedAmount: "1800",
      })
    );
    const recent = seed(
      makeStream({
        id: "recent",
        createdAt: RECENT,
        updatedAt: RECENT,
        email: "recent@example.test",
      })
    );

    const res = await POST(
      authedRequest("", "ops-automation", { "x-request-id": "req-retention-1" })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      scanned: 2,
      eligible: 1,
      alreadyScrubbed: 0,
      purged: 1,
      remaining: 0,
      selectedIds: ["old"],
      purgedIds: ["old"],
      dryRun: false,
      limit: 100,
    });
    expect(Math.abs(Date.parse(body.cutoff) - (Date.now() - 7 * YEAR_MS))).toBeLessThan(
      5_000
    );

    const scrubbed = db.streams.get("old");
    expect(scrubbed).toMatchObject({
      id: old.id,
      recipient: old.recipient,
      rate: old.rate,
      status: old.status,
      totalAmount: "3600",
      vestedAmount: "1800",
    });
    expect(scrubbed?.email).toBeUndefined();
    expect(scrubbed?.label).toBeUndefined();
    expect(scrubbed?.memo).toBeUndefined();
    expect(scrubbed?.partnerId).toBeUndefined();
    expect(db.streams.get("recent")).toEqual(recent);

    const audit = auditLogStore.list({ action: RETENTION_PURGE_ACTION });
    expect(audit).toHaveLength(1);
    expect(audit[0].actor).toEqual({ id: "internal-service", role: "system" });
    expect(audit[0].target).toEqual({ type: "stream", id: "old" });
    expect(audit[0].requestId).toBe("req-retention-1");
    expect(audit[0].metadata).toMatchObject({ service: "ops-automation" });
    expect(auditLogStore.assertIntegrity()).toBe(true);
  });

  it("supports dryRun without mutating streams or writing audit events", async () => {
    const old = seed(
      makeStream({ id: "old", email: "old@example.test", label: "Old Label" })
    );

    const res = await POST(authedRequest(JSON.stringify({ dryRun: true })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      eligible: 1,
      purged: 0,
      selectedIds: ["old"],
      purgedIds: [],
      dryRun: true,
    });
    expect(db.streams.get("old")).toEqual(old);
    expect(auditLogStore.list({ action: RETENTION_PURGE_ACTION })).toHaveLength(0);
  });

  it("honours limit and reports the remaining backlog", async () => {
    seed(
      makeStream({
        id: "oldest",
        createdAt: new Date(Date.now() - 9 * YEAR_MS).toISOString(),
        email: "oldest@example.test",
      })
    );
    seed(
      makeStream({
        id: "middle",
        createdAt: new Date(Date.now() - 8 * YEAR_MS).toISOString(),
        email: "middle@example.test",
      })
    );
    seed(
      makeStream({
        id: "newest",
        createdAt: new Date(Date.now() - 7 * YEAR_MS - DAY_MS).toISOString(),
        email: "newest@example.test",
      })
    );

    const res = await POST(authedRequest(JSON.stringify({ limit: 2 })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      eligible: 3,
      purged: 2,
      remaining: 1,
      purgedIds: ["oldest", "middle"],
      limit: 2,
    });
    expect(db.streams.get("newest")?.email).toBe("newest@example.test");
    expect(auditLogStore.list({ action: RETENTION_PURGE_ACTION })).toHaveLength(2);
  });

  it("is idempotent when re-run", async () => {
    seed(makeStream({ id: "old", email: "old@example.test" }));

    const first = await POST(authedRequest(""));
    expect((await first.json()).purged).toBe(1);

    const second = await POST(authedRequest(""));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      eligible: 0,
      alreadyScrubbed: 1,
      purged: 0,
      purgedIds: [],
    });
    expect(auditLogStore.list({ action: RETENTION_PURGE_ACTION })).toHaveLength(1);
  });

  it("leaves streams with unparsable createdAt untouched", async () => {
    const invalid = seed(
      makeStream({ id: "invalid", createdAt: "not-a-date", email: "a@b.test" })
    );

    const res = await POST(authedRequest(""));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ eligible: 0, purged: 0 });
    expect(db.streams.get(invalid.id)).toEqual(invalid);
  });

  it.each([
    ["array body", "[]"],
    ["non-boolean dryRun", JSON.stringify({ dryRun: "yes" })],
    ["zero limit", JSON.stringify({ limit: 0 })],
    ["limit above max", JSON.stringify({ limit: 501 })],
    ["fractional limit", JSON.stringify({ limit: 1.5 })],
    ["malformed JSON", "not-json"],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await POST(authedRequest(body));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("defaults to a non-dry run with the default limit when the body is empty", async () => {
    const res = await POST(authedRequest(""));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: false, limit: 100 });
  });
});
