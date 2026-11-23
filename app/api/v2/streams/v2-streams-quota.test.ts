/**
 * @jest-environment node
 *
 * Per-org daily quota tests for POST /api/v2/streams.
 *
 * Coverage:
 *   - Successful stream creation under quota (201)
 *   - Quota exhaustion returns 429 with Retry-After header
 *   - 429 error body contains ORG_DAILY_QUOTA_EXCEEDED code
 *   - Metric is recorded on rejection
 *   - Idempotent replay is not counted against quota
 *   - Quota is scoped per identity (two different callers share nothing)
 *   - Quota resets at UTC midnight (fake-timer test)
 *   - OrgQuotaStore peek() reflects correct state
 *   - UTC day helpers return correct values
 */

import { POST as createStreamV2 } from "@/app/api/v2/streams/route";
import { signToken } from "@/app/lib/auth";
import { resetDb } from "@/app/lib/db";
import {
  InMemoryOrgQuotaStore,
  setOrgQuotaStore,
  resetOrgQuotaStore,
  utcDateString,
  secondsUntilUtcMidnight,
} from "@/app/lib/org-quota-store";
import {
  resetOrgQuotaMetrics,
  getOrgQuotaMetrics,
} from "@/app/lib/org-quota-metrics";
import { ORG_DAILY_STREAM_QUOTA } from "@/app/lib/rate-limit-config";

// ── Helpers ────────────────────────────────────────────────────────────────

function makePostRequest(
  body: unknown = { recipient: "GABC123", rate: "50 XLM/month", schedule: "30 days" },
  headers: Record<string, string> = {},
  wallet = "GORG_DEFAULT_WALLET",
) {
  const authHeader = headers["Authorization"] ?? `Bearer ${signToken(wallet)}`;
  return new Request("http://localhost/api/v2/streams", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────

let quotaStore: InMemoryOrgQuotaStore;

beforeEach(() => {
  resetDb();
  resetOrgQuotaMetrics();

  // Give each test a fresh, isolated quota store.
  quotaStore = new InMemoryOrgQuotaStore();
  setOrgQuotaStore(quotaStore);
});

afterEach(() => {
  quotaStore.destroy();
  resetOrgQuotaStore();
});

// ── Quota config ───────────────────────────────────────────────────────────

describe("ORG_DAILY_STREAM_QUOTA config", () => {
  it("has a positive limit", () => {
    expect(ORG_DAILY_STREAM_QUOTA.limit).toBeGreaterThan(0);
  });

  it("has a 24-hour window", () => {
    expect(ORG_DAILY_STREAM_QUOTA.windowMs).toBe(24 * 60 * 60_000);
  });
});

// ── Successful creation ────────────────────────────────────────────────────

describe("POST /api/v2/streams — happy path", () => {
  it("returns 201 when under quota", async () => {
    const res = await createStreamV2(
      makePostRequest(undefined, {}, "GORG_UNDER_QUOTA"),
    );
    expect(res.status).toBe(201);
  });

  it("response body is v2-shaped (allowed_actions, created_at, settlement)", async () => {
    const res = await createStreamV2(
      makePostRequest(undefined, {}, "GORG_SHAPE_TEST"),
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toHaveProperty("allowed_actions");
    expect(data).toHaveProperty("created_at");
    expect(data).toHaveProperty("next_action");
    expect(data).toHaveProperty("settlement", null);
  });

  it("increments the org counter after a successful create", async () => {
    const res = await createStreamV2(
      makePostRequest(undefined, {}, "GORG_PEEK"),
    );
    expect(res.status).toBe(201);
    const count = await quotaStore.peek("GORG_PEEK");
    expect(count).toBe(1);
  });
});

// ── Quota exhaustion ───────────────────────────────────────────────────────

describe("POST /api/v2/streams — quota exceeded", () => {
  it("allows the limit-th request and returns 429 on limit+1", async () => {
    const wallet = "GORG_OVERFLOW";
    const { limit } = ORG_DAILY_STREAM_QUOTA;

    // Pre-fill counter to limit - 1 so the next request is the exact boundary.
    for (let i = 0; i < limit - 1; i++) {
      await quotaStore.increment(wallet);
    }

    const atLimitRes = await createStreamV2(makePostRequest(undefined, {}, wallet));
    expect(atLimitRes.status).toBe(201);

    const overLimitRes = await createStreamV2(makePostRequest(undefined, {}, wallet));
    expect(overLimitRes.status).toBe(429);
  });

  it("429 body has ORG_DAILY_QUOTA_EXCEEDED error code", async () => {
    const alwaysFullStore: import("@/app/lib/org-quota-store").OrgQuotaStore = {
      async increment() {
        return { count: 9999, retryAfter: 3600 };
      },
      async peek() {
        return 9999;
      },
    };
    setOrgQuotaStore(alwaysFullStore);

    const res = await createStreamV2(
      makePostRequest(undefined, {}, "GORG_ALWAYS_FULL"),
    );
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error.code).toBe("ORG_DAILY_QUOTA_EXCEEDED");
    expect(body.error.message).toBeTruthy();
  });

  it("429 response includes a positive integer Retry-After header", async () => {
    const fakeTimers = jest.useFakeTimers();
    try {
      // Pin time to 2026-01-15 22:00:00 UTC -> 7200s until UTC midnight.
      fakeTimers.setSystemTime(new Date("2026-01-15T22:00:00Z").getTime());

      const wallet = "GORG_RETRY_AFTER";
      const { limit } = ORG_DAILY_STREAM_QUOTA;
      for (let i = 0; i < limit; i++) {
        await quotaStore.increment(wallet);
      }

      const res = await createStreamV2(makePostRequest(undefined, {}, wallet));

      expect(res.status).toBe(429);
      const retryAfter = res.headers.get("Retry-After");
      expect(retryAfter).toBe("7200");
      expect(Number.isInteger(Number(retryAfter))).toBe(true);
      expect(Number(retryAfter)).toBeGreaterThan(0);
    } finally {
      fakeTimers.useRealTimers();
    }
  });
});

// ── Metric emission ────────────────────────────────────────────────────────

describe("quota rejection metric", () => {
  it("records a rejection event when 429 is returned", async () => {
    const alwaysFullStore: import("@/app/lib/org-quota-store").OrgQuotaStore = {
      async increment() {
        return { count: 9999, retryAfter: 3600 };
      },
      async peek() {
        return 9999;
      },
    };
    setOrgQuotaStore(alwaysFullStore);

    await createStreamV2(makePostRequest(undefined, {}, "GORG_METRIC"));

    const { rejections } = getOrgQuotaMetrics();
    expect(rejections["GORG_METRIC"]).toBe(1);
  });

  it("does NOT emit a metric on a successful create", async () => {
    const res = await createStreamV2(
      makePostRequest(undefined, {}, "GORG_NO_METRIC"),
    );
    expect(res.status).toBe(201);

    const { rejections } = getOrgQuotaMetrics();
    expect(rejections["GORG_NO_METRIC"]).toBeUndefined();
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe("idempotent replay does not consume quota", () => {
  it("second call with same Idempotency-Key returns 201 and does not increment counter", async () => {
    const wallet = "GORG_IDEM";
    const headers = {
      "Idempotency-Key": "idem-quota-1",
    };
    const body = { recipient: "GIDEM", rate: "10 XLM/day", schedule: "daily" };

    // First call — consumes 1 quota unit.
    const res1 = await createStreamV2(makePostRequest(body, headers, wallet));
    expect(res1.status).toBe(201);
    const countAfterFirst = await quotaStore.peek(wallet);
    expect(countAfterFirst).toBe(1);

    // Second call — replayed, should NOT increment.
    const res2 = await createStreamV2(makePostRequest(body, headers, wallet));
    const countAfterSecond = await quotaStore.peek(wallet);

    expect(res2.status).toBe(201);
    expect(countAfterSecond).toBe(countAfterFirst);
  });
});

// ── Per-identity scoping ───────────────────────────────────────────────────

describe("quota is scoped per identity", () => {
  it("two different orgs have independent counters", async () => {
    await createStreamV2(makePostRequest(undefined, {}, "GORG_ALPHA"));
    await createStreamV2(makePostRequest(undefined, {}, "GORG_ALPHA"));
    await createStreamV2(makePostRequest(undefined, {}, "GORG_BETA"));

    expect(await quotaStore.peek("GORG_ALPHA")).toBe(2);
    expect(await quotaStore.peek("GORG_BETA")).toBe(1);
  });
});

// ── UTC midnight reset ─────────────────────────────────────────────────────

describe("quota resets at UTC midnight", () => {
  it("counter restarts after a day boundary", async () => {
    const fakeTimers = jest.useFakeTimers();
    try {
      // Pin time to a known moment — 2026-01-15 23:59:59 UTC.
      fakeTimers.setSystemTime(new Date("2026-01-15T23:59:59Z").getTime());

      await createStreamV2(makePostRequest(undefined, {}, "GORG_MIDNIGHT"));
      expect(await quotaStore.peek("GORG_MIDNIGHT")).toBe(1);

      // Advance past midnight to 2026-01-16 00:00:01 UTC.
      fakeTimers.advanceTimersByTime(2_000);

      await createStreamV2(makePostRequest(undefined, {}, "GORG_MIDNIGHT"));

      // The new day's counter should start at 1, not 2.
      expect(await quotaStore.peek("GORG_MIDNIGHT")).toBe(1);
    } finally {
      fakeTimers.useRealTimers();
    }
  });
});

// ── UTC helper unit tests ──────────────────────────────────────────────────

describe("utcDateString()", () => {
  it("returns YYYY-MM-DD format for a known timestamp", () => {
    const ts = new Date("2026-06-15T14:30:00Z").getTime();
    expect(utcDateString(ts)).toBe("2026-06-15");
  });

  it("handles midnight boundary correctly", () => {
    // Just before midnight
    expect(utcDateString(new Date("2026-01-01T23:59:59.999Z").getTime())).toBe("2026-01-01");
    // Just after midnight
    expect(utcDateString(new Date("2026-01-02T00:00:00.000Z").getTime())).toBe("2026-01-02");
  });
});

describe("secondsUntilUtcMidnight()", () => {
  it("returns a positive integer", () => {
    const result = secondsUntilUtcMidnight();
    expect(result).toBeGreaterThan(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("returns at most 86400 seconds", () => {
    expect(secondsUntilUtcMidnight()).toBeLessThanOrEqual(86_400);
  });

  it("returns correct value for a known time", () => {
    // 2026-01-01 22:00:00 UTC → 2 hours = 7200 s until midnight.
    const ts = new Date("2026-01-01T22:00:00Z").getTime();
    expect(secondsUntilUtcMidnight(ts)).toBe(7_200);
  });

  it("returns minimum 1 second when called exactly at midnight", () => {
    const ts = new Date("2026-01-01T00:00:00.000Z").getTime();
    // Exactly at midnight: next midnight is 86400 s away.
    expect(secondsUntilUtcMidnight(ts)).toBe(86_400);
  });
});

// ── Validation still works ─────────────────────────────────────────────────

describe("request validation is unaffected by quota", () => {
  it("returns 422 for missing fields", async () => {
    const res = await createStreamV2(
      makePostRequest({ recipient: "GABC" }, {}, "GORG_VALIDATION"),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost/api/v2/streams", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signToken("GORG_BADJSON")}`,
      },
      body: "not-json",
    });
    const res = await createStreamV2(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_REQUEST");
  });
});
