/**
 * app/api/streams/route.timeout.test.ts
 *
 * Focused tests proving the route-level timeout cancellation is wired into
 * GET and POST /api/streams (Issue #43).
 *
 * Strategy: replace `withRouteTimeout` from `src/middleware/timeout` with a
 * controllable stub so we can force a 504 deterministically, and set a
 * generous rate-limit store so limiting never interferes with the assertions.
 */

import { GET, POST } from "./route";
import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { signToken } from "@/app/lib/auth";

jest.mock("@/app/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getCorrelationContext: jest.fn().mockReturnValue({
    request_id: "test-req-id",
    correlation_id: "test-corr-id",
  }),
}));

// `__simulateTimeout` drives whether the next route call returns a 504.
let __simulateTimeout = false;

jest.mock("@/src/middleware/timeout", () => {
  const { errorResponse, ErrorCode } = jest.requireActual(
    "@/app/lib/errors/server",
  );

  const withRouteTimeout = jest.fn(
    async (
      _request: unknown,
      work: (signal: AbortSignal) => Promise<unknown>,
    ) => {
      if (__simulateTimeout) {
        return errorResponse(
          ErrorCode.GATEWAY_TIMEOUT,
          "Request exceeded the route deadline.",
          504,
        );
      }
      const controller = new AbortController();
      return work(controller.signal);
    },
  );

  return { withRouteTimeout };
});

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const VALID_SENDER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const AUTH_HEADER = `Bearer ${signToken(VALID_SENDER)}`;

function makeRequest(url: string): Request {
  return new Request(url);
}

beforeEach(() => {
  __simulateTimeout = false;
  jest.clearAllMocks();
  resetDb();
  resetRateLimitStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
  // Generous store so rate limits don't interfere with timeout tests.
  setRateLimitStore({
    async check() {
      return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 };
    },
  });
});

afterEach(() => {
  __simulateTimeout = false;
  resetRateLimitStore();
  resetDb();
});

describe("GET /api/streams — route-level timeout", () => {
  it("returns 504 GATEWAY_TIMEOUT when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const res = await GET(makeRequest("http://localhost/api/streams"));
    expect(res.status).toBe(504);
  });

  it("504 body has the standard GATEWAY_TIMEOUT envelope", async () => {
    __simulateTimeout = true;
    const res = await GET(makeRequest("http://localhost/api/streams"));
    const body = await res.json();
    expect(body.error.code).toBe("GATEWAY_TIMEOUT");
    expect(body).toMatchObject({
      error: {
        code: "GATEWAY_TIMEOUT",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
  });

  it("returns 200 normally when within the deadline", async () => {
    const res = await GET(makeRequest("http://localhost/api/streams"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
  });
});

describe("POST /api/streams — route-level timeout", () => {
  const validBody = JSON.stringify({
    recipient: VALID_RECIPIENT,
    rate: "1",
    schedule: "day",
    token: "XLM",
  });

  it("returns 504 GATEWAY_TIMEOUT when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const res = await POST(
      new Request("http://localhost/api/streams", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          "Idempotency-Key": "test-key-timeout-504",
        },
        body: validBody,
      }),
    );
    expect(res.status).toBe(504);
  });

  it("returns 201 normally when within the deadline", async () => {
    const res = await POST(
      new Request("http://localhost/api/streams", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: AUTH_HEADER,
          "Idempotency-Key": "test-key-timeout-201",
        },
        body: validBody,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.status).toBe("draft");
    expect(body.links.self).toBeDefined();
  });
});
