/** @jest-environment node */
import { POST } from "./route";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetOrgQuotaStore } from "@/app/lib/org-quota-store";
import { MAX_RECIPIENTS } from "@/app/lib/multi-recipient";

jest.mock("@/app/lib/rate-limit", () => {
  const actual = jest.requireActual("@/app/lib/rate-limit") as Record<string, unknown>;
  return {
    ...actual,
    getClientIdentity: jest.fn(() => ({
      type: "ip" as const,
      value: "127.0.0.1",
      displayValue: "127.0.0.1",
    })),
  };
});

const KEY_A = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const EMAIL_A = "ada@example.com";
const EMAIL_B = "grace@example.com";

/** Allocation metadata the route stamps on each leg (not part of `Stream`). */
interface LegMetadata {
  multiGroupId: string;
  multiRank: number;
  multiLegCount: number;
  multiPercentage: string;
  multiStartAt: string;
  multiEndAt: string;
}

const validBody = {
  name: "GrantFox Q3 Distribution",
  token: "XLM",
  totalAmount: 10000,
  startTime: "2026-09-01T09:00:00.000Z",
  endTime: "2026-12-31T23:59:00.000Z",
  recipients: [
    { address: KEY_A, percentage: 50, amount: 5000 },
    { address: EMAIL_A, percentage: 50, amount: 5000 },
  ],
};

function makeRequest(
  body: unknown,
  { auth = "Bearer test-token", idempotencyKey }: { auth?: string | null; idempotencyKey?: string } = {},
): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers["Authorization"] = auth;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  return new Request("http://localhost/api/v2/streams/multi", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  resetOrgQuotaStore();
});

// ── Authentication ───────────────────────────────────────────────────────────

describe("POST /api/v2/streams/multi — auth", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await POST(makeRequest(validBody, { auth: null }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const res = await POST(makeRequest(validBody, { auth: "Basic abc" }));
    expect(res.status).toBe(401);
  });

  it("does not persist anything when unauthenticated", async () => {
    await POST(makeRequest(validBody, { auth: null }));
    expect(getStore().streamRepository.streams.size).toBe(0);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe("POST /api/v2/streams/multi — creation", () => {
  it("returns 201 with a group manifest", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.id).toMatch(/^stream-multi-[0-9a-f]{8}$/);
    expect(body.kind).toBe("multi_recipient");
    expect(body.name).toBe("GrantFox Q3 Distribution");
    expect(body.token).toBe("XLM");
    expect(body.status).toBe("draft");
    expect(body.total_amount).toBe("10000.0000000");
    expect(body.allocated_percentage).toBe("100.0000");
    expect(body.recipient_count).toBe(2);
    expect(body.settlement).toBeNull();
  });

  it("normalises the window to ISO-8601 UTC", async () => {
    const res = await POST(
      makeRequest({
        ...validBody,
        startTime: "2026-09-01T09:00",
        endTime: "2026-12-31T23:59",
      }),
    );
    const body = await res.json();
    expect(body.start_at).toBe(new Date("2026-09-01T09:00").toISOString());
    expect(body.end_at).toBe(new Date("2026-12-31T23:59").toISOString());
  });

  it("creates one independently addressable stream leg per recipient", async () => {
    const res = await POST(makeRequest(validBody));
    const body = await res.json();

    expect(body.recipients).toHaveLength(2);
    expect(body.recipients[0]).toMatchObject({
      rank: 1,
      address: KEY_A,
      percentage: "50.0000",
      amount: "5000.0000000",
    });
    expect(body.recipients[1].rank).toBe(2);

    const { streams } = getStore().streamRepository;
    expect(streams.size).toBe(2);

    for (const summary of body.recipients) {
      const leg = streams.get(summary.stream_id);
      expect(leg).toBeDefined();
      expect(leg!.recipient).toBe(summary.address);
      expect(leg!.status).toBe("draft");
      expect(leg!.nextAction).toBe("start");
      expect(leg!.totalAmount).toBe(summary.amount);
      expect(leg!.token).toBe("XLM");

      const meta = leg as unknown as LegMetadata;
      expect(meta.multiGroupId).toBe(body.id);
      expect(meta.multiLegCount).toBe(2);
      expect(meta.multiStartAt).toBe(body.start_at);
      expect(meta.multiEndAt).toBe(body.end_at);
    }

    const ranks = body.recipients.map((r: { rank: number }) => r.rank);
    expect(ranks).toEqual([1, 2]);
  });

  it("makes the leg amounts sum exactly to the requested total", async () => {
    const res = await POST(
      makeRequest({
        ...validBody,
        totalAmount: 1000,
        recipients: [
          { address: KEY_A, percentage: 33.3333 },
          { address: EMAIL_A, percentage: 33.3333 },
          { address: EMAIL_B, percentage: 33.3334 },
        ],
      }),
    );
    expect(res.status).toBe(201);

    const body = await res.json();
    const total = body.recipients.reduce((sum: number, r: { amount: string }) => sum + Number(r.amount), 0);
    expect(total).toBeCloseTo(1000, 7);
    expect(body.recipients.every((r: { amount: string }) => Number(r.amount) > 0)).toBe(true);
  });

  it("accepts exactly the 20-recipient cap", async () => {
    const recipients = new Array(MAX_RECIPIENTS).fill(0).map(() => ({
      address: KEY_A,
      percentage: 100 / MAX_RECIPIENTS,
    }));

    const res = await POST(makeRequest({ ...validBody, recipients }));
    expect(res.status).toBe(201);
    expect((await res.json()).recipient_count).toBe(MAX_RECIPIENTS);
  });
});

// ── Validation ───────────────────────────────────────────────────────────────

describe("POST /api/v2/streams/multi — validation", () => {
  it("returns 400 for a body that is not valid JSON", async () => {
    const res = await POST(makeRequest("not-json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_REQUEST");
  });

  it("returns 422 with field details when percentages do not sum to 100", async () => {
    const res = await POST(
      makeRequest({
        ...validBody,
        recipients: [
          { address: KEY_A, percentage: 50 },
          { address: EMAIL_A, percentage: 40 },
        ],
      }),
    );
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "recipients", code: "ALLOCATION_MISMATCH" }),
      ]),
    );
  });

  it(`returns 422 TOO_MANY_RECIPIENTS for ${MAX_RECIPIENTS + 1} recipients`, async () => {
    const recipients = new Array(MAX_RECIPIENTS + 1).fill(0).map(() => ({
      address: KEY_A,
      percentage: 100 / (MAX_RECIPIENTS + 1),
    }));

    const res = await POST(makeRequest({ ...validBody, recipients }));
    expect(res.status).toBe(422);

    const body = await res.json();
    const cap = body.error.details.find((d: { code: string }) => d.code === "TOO_MANY_RECIPIENTS");
    expect(cap).toBeDefined();
    expect(cap.message).toContain(`at most ${MAX_RECIPIENTS}`);
  });

  it("returns 422 for a malformed recipient address", async () => {
    const res = await POST(
      makeRequest({ ...validBody, recipients: [{ address: "GABC123", percentage: 100 }] }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details[0]).toMatchObject({
      field: "recipients.0.address",
      code: "INVALID_RECIPIENT_ADDRESS",
    });
  });

  it("returns 422 when endTime is not after startTime", async () => {
    const res = await POST(makeRequest({ ...validBody, endTime: validBody.startTime }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details[0].code).toBe("INVALID_TIME_RANGE");
  });

  it("returns 422 for an unsupported token", async () => {
    const res = await POST(makeRequest({ ...validBody, token: "USDT" }));
    expect(res.status).toBe(422);
  });

  it("writes no stream when validation fails", async () => {
    await POST(
      makeRequest({
        ...validBody,
        recipients: [
          { address: KEY_A, percentage: 50 },
          { address: EMAIL_A, percentage: 40 },
        ],
      }),
    );
    expect(getStore().streamRepository.streams.size).toBe(0);
  });

  it("never reflects the raw request body back in the error message", async () => {
    const res = await POST(makeRequest({ ...validBody, name: "" }));
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe("POST /api/v2/streams/multi — idempotency", () => {
  it("replays the original 201 for the same key and body", async () => {
    const first = await POST(makeRequest(validBody, { idempotencyKey: "abc" }));
    const second = await POST(makeRequest(validBody, { idempotencyKey: "abc" }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it("does not create duplicate legs on replay", async () => {
    await POST(makeRequest(validBody, { idempotencyKey: "abc" }));
    await POST(makeRequest(validBody, { idempotencyKey: "abc" }));

    expect(getStore().streamRepository.streams.size).toBe(2);
  });

  it("returns 409 when the same key is reused with a different body", async () => {
    await POST(makeRequest(validBody, { idempotencyKey: "abc" }));

    const res = await POST(
      makeRequest({ ...validBody, name: "Different campaign" }, { idempotencyKey: "abc" }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("does not share a cache entry between different keys", async () => {
    const a = await POST(makeRequest(validBody, { idempotencyKey: "key-a" }));
    const b = await POST(
      makeRequest({ ...validBody, name: "Second" }, { idempotencyKey: "key-b" }),
    );

    expect((await a.json()).id).not.toBe((await b.json()).id);
  });

  it("scopes the idempotency namespace to the multi endpoint", async () => {
    await POST(makeRequest(validBody, { idempotencyKey: "shared" }));

    const { idempotencyStore } = getStore();
    const entries = Array.from(idempotencyStore.entries());
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("v2.streams.multi:shared");
  });
});
