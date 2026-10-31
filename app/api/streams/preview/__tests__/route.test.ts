/**
 * @jest-environment node
 *
 * Tests for POST /api/streams/preview
 *
 * The preview endpoint is a pure dry-run: it must NEVER persist a stream.
 * All tests use real in-memory stores (no mocked db) so we can assert the
 * store is unchanged after every call.
 */

import { POST } from "../route";
import { createInMemoryPersistenceStore, getStore, setStore } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { POST as createStream } from "../../route";
import fc from "fast-check";

// ── Mock logger (keeps test output clean) ─────────────────────────────────

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id-preview" })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  withCorrelationContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

// ── Constants ─────────────────────────────────────────────────────────────

const VALID_STELLAR_KEY =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/streams/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function streamCount(): number {
  return getStore().streamRepository.streams.size;
}

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  setStore(createInMemoryPersistenceStore());
  resetRateLimitStore();
  _resetAllowlistForTesting();
});

// ── Valid body ────────────────────────────────────────────────────────────

describe("valid request", () => {
  it("returns 200 with dry_run: true", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.meta.dry_run).toBe(true);
  });

  it("includes a request_id in meta", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "100", schedule: "day" }),
    );
    const body = await res.json();
    expect(typeof body.meta.request_id).toBe("string");
    expect(body.meta.request_id.length).toBeGreaterThan(0);
  });

  it("data.valid is true for a valid body", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "10", schedule: "week" }),
    );
    const body = await res.json();
    expect(body.data.valid).toBe(true);
  });

  it("does NOT persist any stream to the store", async () => {
    const before = streamCount();
    await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "25", schedule: "month" }),
    );
    expect(streamCount()).toBe(before);
  });

  it("multiple calls do not accumulate streams", async () => {
    const before = streamCount();
    await POST(makeRequest({ recipient: VALID_STELLAR_KEY, rate: "1", schedule: "day" }));
    await POST(makeRequest({ recipient: VALID_STELLAR_KEY, rate: "2", schedule: "week" }));
    await POST(makeRequest({ recipient: VALID_STELLAR_KEY, rate: "3", schedule: "month" }));
    expect(streamCount()).toBe(before);
  });
});

// ── cost_estimate ─────────────────────────────────────────────────────────

describe("cost_estimate", () => {
  it("is present in the response", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const body = await res.json();
    expect(body.data).toHaveProperty("cost_estimate");
  });

  it("has the correct shape", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { cost_estimate } = (await res.json()).data;

    expect(typeof cost_estimate.min_balance_xlm).toBe("string");
    expect(typeof cost_estimate.estimated_fees).toBe("string");
    expect(typeof cost_estimate.breakdown).toBe("object");
    expect(typeof cost_estimate.breakdown.base_reserve).toBe("string");
    expect(typeof cost_estimate.breakdown.base_fee).toBe("string");
  });

  it("includes trustline_reserve for non-XLM asset", async () => {
    const res = await POST(
      makeRequest({
        recipient: VALID_STELLAR_KEY,
        rate: "50",
        schedule: "month",
        token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      }),
    );
    const { cost_estimate } = (await res.json()).data;
    expect(cost_estimate.breakdown).toHaveProperty("trustline_reserve");
  });

  it("does not include trustline_reserve for XLM", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month", token: "XLM" }),
    );
    const { cost_estimate } = (await res.json()).data;
    expect(cost_estimate.breakdown).not.toHaveProperty("trustline_reserve");
  });
});

// ── estimated_events ──────────────────────────────────────────────────────

describe("estimated_events", () => {
  it("is an array", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { estimated_events } = (await res.json()).data;
    expect(Array.isArray(estimated_events)).toBe(true);
  });

  it("contains stream.created", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { estimated_events } = (await res.json()).data;
    const types: string[] = estimated_events.map((e: { type: string }) => e.type);
    expect(types).toContain("stream.created");
  });

  it("contains stream.started", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { estimated_events } = (await res.json()).data;
    const types: string[] = estimated_events.map((e: { type: string }) => e.type);
    expect(types).toContain("stream.started");
  });

  it("contains stream.settled", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "day" }),
    );
    const { estimated_events } = (await res.json()).data;
    const types: string[] = estimated_events.map((e: { type: string }) => e.type);
    expect(types).toContain("stream.settled");
  });

  it("contains stream.ended", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "week" }),
    );
    const { estimated_events } = (await res.json()).data;
    const types: string[] = estimated_events.map((e: { type: string }) => e.type);
    expect(types).toContain("stream.ended");
  });

  it("each event has type and description strings", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "hour" }),
    );
    const { estimated_events } = (await res.json()).data;
    for (const event of estimated_events) {
      expect(typeof event.type).toBe("string");
      expect(typeof event.description).toBe("string");
      expect(event.type.length).toBeGreaterThan(0);
      expect(event.description.length).toBeGreaterThan(0);
    }
  });

  it("stream.created is the first event", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "10", schedule: "day" }),
    );
    const { estimated_events } = (await res.json()).data;
    expect(estimated_events[0].type).toBe("stream.created");
  });
});

// ── preview_stream ────────────────────────────────────────────────────────

describe("preview_stream", () => {
  it("is present in data", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    expect((await res.json()).data).toHaveProperty("preview_stream");
  });

  it("has a generated id starting with 'preview-'", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { preview_stream } = (await res.json()).data;
    expect(preview_stream.id).toMatch(/^preview-/);
  });

  it("status is 'draft'", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { preview_stream } = (await res.json()).data;
    expect(preview_stream.status).toBe("draft");
  });

  it("echoes the recipient from the request", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    const { preview_stream } = (await res.json()).data;
    expect(preview_stream.recipient).toBe(VALID_STELLAR_KEY);
  });

  it("echoes the rate as amount", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "99.5", schedule: "week" }),
    );
    const { preview_stream } = (await res.json()).data;
    expect(preview_stream.amount).toBe("99.5");
  });

  it("contains schedule object with interval", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "10", schedule: "day" }),
    );
    const { preview_stream } = (await res.json()).data;
    expect(typeof preview_stream.schedule).toBe("object");
    expect(preview_stream.schedule.interval).toBe("day");
  });

  it("preview_stream id is NOT present in the stream store", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "10", schedule: "day" }),
    );
    const { preview_stream } = (await res.json()).data;
    const stored = getStore().streamRepository.streams.get(preview_stream.id);
    expect(stored).toBeUndefined();
  });
});

// ── Validation errors ─────────────────────────────────────────────────────

describe("validation errors", () => {
  it("returns 422 when body is empty", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(422);
  });

  it("returns VALIDATION_ERROR code for missing required fields", async () => {
    const res = await POST(makeRequest({}));
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when recipient is missing", async () => {
    const res = await POST(makeRequest({ rate: "50", schedule: "month" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when rate is missing", async () => {
    const res = await POST(makeRequest({ recipient: VALID_STELLAR_KEY, schedule: "month" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when schedule is missing", async () => {
    const res = await POST(makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50" }));
    expect(res.status).toBe(422);
  });

  it("includes field-level details in the error envelope", async () => {
    const res = await POST(makeRequest({ rate: "50", schedule: "month" }));
    const body = await res.json();
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
    expect(body.error.details[0]).toHaveProperty("field");
    expect(body.error.details[0]).toHaveProperty("code");
    expect(body.error.details[0]).toHaveProperty("message");
  });

  it("returns 422 when recipient is not a valid Stellar key", async () => {
    const res = await POST(
      makeRequest({ recipient: "not-a-stellar-key", rate: "50", schedule: "month" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details.some((d: { field: string }) => d.field === "recipient")).toBe(true);
  });

  it("returns 422 when rate is zero", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "0", schedule: "month" }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when schedule is not a supported value", async () => {
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "quarterly" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details.some((d: { field: string }) => d.field === "schedule")).toBe(true);
  });

  it("returns 400 for invalid JSON body", async () => {
    const res = await POST(
      new Request("http://localhost/api/streams/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("does not persist anything on a validation failure", async () => {
    const before = streamCount();
    await POST(makeRequest({ recipient: "bad-key", rate: "50", schedule: "month" }));
    expect(streamCount()).toBe(before);
  });

  it("returns the same invalid-recipient details as stream creation", async () => {
    const input = { recipient: "not-a-stellar-key", rate: "50", schedule: "month" };
    const preview = await POST(makeRequest(input));
    const previewBody = await preview.json();
    const created = await createStream(
      new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.229" },
        body: JSON.stringify(input),
      }),
    );
    const createBody = await created.json();

    expect(preview.status).toBe(422);
    expect(previewBody.error.code).toBe("VALIDATION_ERROR");
    expect(previewBody.error.details).toEqual(createBody.error.details);
  });

  it("rejects non-allowlisted tokens exactly like stream creation", async () => {
    addAllowedToken("XLM");
    const input = {
      recipient: VALID_STELLAR_KEY,
      rate: "1",
      schedule: "day",
      token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    };
    const preview = await POST(makeRequest(input));
    const previewBody = await preview.json();
    const created = await createStream(
      new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "192.0.2.230" },
        body: JSON.stringify(input),
      }),
    );
    const createBody = await created.json();

    expect(preview.status).toBe(422);
    expect(previewBody.data.valid).toBe(false);
    expect(previewBody.error.code).toBe("TOKEN_NOT_ALLOWED");
    expect(previewBody.error).toEqual(createBody.error);
  });

  it("does not treat an allowlisted EURC token as USDC for cost estimation", async () => {
    const eurc = "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPPA";
    addAllowedToken(eurc);
    const res = await POST(
      makeRequest({ recipient: VALID_STELLAR_KEY, rate: "5", schedule: "day", token: eurc }),
    );
    const body = await res.json();
    expect(body.data.valid).toBe(true);
    expect(body.data.preview_stream.asset).toBe(eurc);
    expect(body.data.cost_estimate).toBeNull();
    expect(body.data.cost_estimate_reason).toContain("EURC");
    expect(body.data.cost_estimate_reason).not.toContain("USDC");
  });

  it("matches stream creation status for generated bodies", async () => {
    let requestId = 0;
    await fc.assert(
      fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue()), async (body) => {
        const ip = `198.51.100.${(requestId++ % 250) + 1}`;
        const preview = await POST(
          makeRequest(body, { "x-forwarded-for": ip }),
        );
        const created = await createStream(
          new Request("http://localhost/api/streams", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-forwarded-for": ip,
              "Idempotency-Key": `property-${requestId}`,
            },
            body: JSON.stringify(body),
          }),
        );
        const previewBody = await preview.json();
        expect(previewBody.data?.valid === true).toBe(created.status === 201);
      }),
      { numRuns: 40 },
    );
  });

  it("does not write stream or idempotency stores across 1000 previews", async () => {
    setStore(createInMemoryPersistenceStore());
    const store = getStore();
    const streamsBefore = store.streamRepository.streams.size;
    const idempotencyBefore = store.idempotencyStore.size;
    for (let i = 0; i < 1000; i++) {
      const res = await POST(
        makeRequest(
          { recipient: VALID_STELLAR_KEY, rate: "1", schedule: "day" },
          { "x-forwarded-for": `203.0.113.${(i % 254) + 1}` },
        ),
      );
      expect(res.status).toBe(200);
    }
    expect(store.streamRepository.streams.size).toBe(streamsBefore);
    expect(store.idempotencyStore.size).toBe(idempotencyBefore);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────

describe("rate limiting", () => {
  it("returns 429 after exceeding the write limit", async () => {
    const req = makeRequest(
      { recipient: VALID_STELLAR_KEY, rate: "1", schedule: "day" },
      { "x-forwarded-for": "192.0.2.100" },
    );

    let limited = false;
    let retryAfter: string | null = null;

    // The write tier allows 10 req/min; send enough to trigger the limit.
    for (let i = 0; i < 15; i++) {
      const freshReq = makeRequest(
        { recipient: VALID_STELLAR_KEY, rate: "1", schedule: "day" },
        { "x-forwarded-for": "192.0.2.100" },
      );
      const res = await POST(freshReq);
      if (res.status === 429) {
        limited = true;
        retryAfter = res.headers.get("retry-after");
        break;
      }
    }

    expect(limited).toBe(true);
    expect(retryAfter).not.toBeNull();
  });

  it("rate-limited response body has error.code rate_limit_exceeded", async () => {
    let lastBody: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      const freshReq = makeRequest(
        { recipient: VALID_STELLAR_KEY, rate: "1", schedule: "day" },
        { "x-forwarded-for": "192.0.2.200" },
      );
      const res = await POST(freshReq);
      if (res.status === 429) {
        lastBody = await res.json();
        break;
      }
    }
    expect((lastBody.error as Record<string, unknown>)?.code).toBe("rate_limit_exceeded");
  });
});

// ── All supported schedules ───────────────────────────────────────────────

describe("all supported schedules return 200", () => {
  const schedules = ["second", "minute", "hour", "day", "week", "month", "year"];

  for (const schedule of schedules) {
    it(`schedule="${schedule}" returns 200`, async () => {
      const res = await POST(
        makeRequest({ recipient: VALID_STELLAR_KEY, rate: "1", schedule }),
      );
      expect(res.status).toBe(200);
    });
  }
});

// ── INVALID_TOKEN (malformed token string) ────────────────────────────────

describe("INVALID_TOKEN branch", () => {
  it("returns 422 INVALID_TOKEN for a malformed token string", async () => {
    // "BADFORMAT" is a string (passes Zod's typeof check) but fails
    // normaliseToken because it has no colon and is not XLM.
    const res = await POST(
      makeRequest({
        recipient: VALID_STELLAR_KEY,
        rate: "5",
        schedule: "day",
        token: "BADFORMAT",
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_TOKEN");
    expect(body.data.valid).toBe(false);
  });

  it("INVALID_TOKEN response also includes data envelope with valid: false", async () => {
    const res = await POST(
      makeRequest({
        recipient: VALID_STELLAR_KEY,
        rate: "1",
        schedule: "week",
        token: "NOISSUER",
      }),
    );
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.valid).toBe(false);
    expect(body.data.cost_estimate).toBeNull();
    expect(body.data.preview_stream).toBeNull();
  });
});

// ── Cost estimator unavailable path ──────────────────────────────────────

describe("cost_estimate unavailable for unsupported asset", () => {
  it("returns null cost_estimate with a reason mentioning the asset code", async () => {
    // EURC is allowlisted → valid: true, but EURC is not in SUPPORTED_ASSETS
    // so estimateStreamCost is not called; cost_estimate is null.
    const eurc = "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPPA";
    addAllowedToken(eurc);
    const res = await POST(
      makeRequest({
        recipient: VALID_STELLAR_KEY,
        rate: "1",
        schedule: "month",
        token: eurc,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.valid).toBe(true);
    expect(body.data.cost_estimate).toBeNull();
    expect(typeof body.data.cost_estimate_reason).toBe("string");
    expect(body.data.cost_estimate_reason).toContain("EURC");
  });
});
