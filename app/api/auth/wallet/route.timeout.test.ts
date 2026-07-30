/**
 * app/api/auth/wallet/route.timeout.test.ts
 *
 * Focused tests for the per-request timeout behaviour of
 * GET and POST /api/auth/wallet.
 *
 * Strategy: replace `withTimeout` from `src/middleware/timeout` with a
 * controllable stub so we can trigger a timeout synchronously without
 * using real timers.  This keeps the tests fast and deterministic.
 *
 * Coverage
 * ─────────
 * • GET returns 504 with GATEWAY_TIMEOUT when the deadline passes.
 * • POST returns 504 with GATEWAY_TIMEOUT when the deadline passes.
 * • 504 body shape matches the standard error envelope.
 * • GET returns 200 normally when within the deadline.
 * • POST returns 200 normally when within the deadline.
 * • Rate-limit 429 is returned before the timeout check fires (timeout is
 *   never invoked for a throttled caller).
 */

import { NextRequest } from "next/server";
import { GET, POST, resetWalletChallengeStoreForTesting } from "./route";
import { resetRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// Mock the timeout middleware so we can drive timeout scenarios.
// `__simulateTimeout` controls whether the next call should time out.
let __simulateTimeout = false;

jest.mock("@/src/middleware/timeout", () => {
  const { NextResponse } = require("next/server");
  const { errorResponse, ErrorCode } = jest.requireActual(
    "@/app/lib/errors/server",
  );

  const withTimeout = jest.fn(
    async (
      _timeoutMs: number,
      _request: unknown,
      work: (signal: AbortSignal) => Promise<unknown>,
    ) => {
      if (__simulateTimeout) {
        return errorResponse(
          ErrorCode.GATEWAY_TIMEOUT,
          `Request exceeded the ${_timeoutMs}ms deadline.`,
          504,
        );
      }
      const controller = new AbortController();
      return work(controller.signal);
    },
  );

  return {
    withTimeout,
    WALLET_CHALLENGE_TIMEOUT_MS: 5_000,
    WALLET_VERIFY_TIMEOUT_MS: 5_000,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_ADDRESS = "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";
const VALID_CHALLENGE = "streampay_auth_1721800000000_abc123def";

function makeGetRequest(search = "") {
  return new NextRequest(
    `http://localhost/api/auth/wallet${search}`,
    {
      method: "GET",
      headers: new Headers({
        "x-forwarded-for": "203.0.113.1",
        "x-request-id": "test-req-timeout",
      }),
    },
  );
}

function makePostRequest(body: Record<string, string>, csrfToken = "csrf-abc") {
  return new NextRequest("http://localhost/api/auth/wallet", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.1",
      "x-request-id": "test-req-timeout",
      cookie: `csrf-token=${csrfToken}`,
      "x-csrf-token": csrfToken,
    }),
    body: JSON.stringify(body),
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  __simulateTimeout = false;
  jest.clearAllMocks();
  resetRateLimitStore();
  resetWalletChallengeStoreForTesting();
  // Generous store so rate limits don't interfere with timeout tests
  setRateLimitStore({
    async check() {
      return { allowed: true, remaining: 999, resetAt: Date.now() + 60_000 };
    },
  });
});

afterEach(() => {
  resetRateLimitStore();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/auth/wallet — timeout", () => {
  it("returns 504 when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const res = await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    expect(res.status).toBe(504);
  });

  it("504 body has GATEWAY_TIMEOUT error code", async () => {
    __simulateTimeout = true;
    const res = await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    const body = await res.json();
    expect(body.error.code).toBe("GATEWAY_TIMEOUT");
  });

  it("504 body matches the standard error envelope shape", async () => {
    __simulateTimeout = true;
    const res = await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        code: "GATEWAY_TIMEOUT",
        message: expect.stringContaining("deadline"),
        request_id: expect.any(String),
      },
    });
  });

  it("returns 200 normally when within the deadline", async () => {
    const res = await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.challenge).toMatch(/^streampay_auth_/);
  });

  it("invokes withTimeout with the challenge deadline constant", async () => {
    const { withTimeout } = jest.requireMock("@/src/middleware/timeout");
    await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    expect(withTimeout).toHaveBeenCalledWith(
      5_000,
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe("POST /api/auth/wallet — timeout", () => {
  it("returns 504 when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const res = await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    expect(res.status).toBe(504);
  });

  it("504 body has GATEWAY_TIMEOUT error code", async () => {
    __simulateTimeout = true;
    const res = await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    const body = await res.json();
    expect(body.error.code).toBe("GATEWAY_TIMEOUT");
  });

  it("504 body matches the standard error envelope shape", async () => {
    __simulateTimeout = true;
    const res = await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        code: "GATEWAY_TIMEOUT",
        message: expect.any(String),
        request_id: expect.any(String),
      },
    });
  });

  it("returns 200 normally when within the deadline", async () => {
    const res = await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^tok_/);
  });

  it("invokes withTimeout with the verify deadline constant", async () => {
    const { withTimeout } = jest.requireMock("@/src/middleware/timeout");
    await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    expect(withTimeout).toHaveBeenCalledWith(
      5_000,
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe("rate limit fires before timeout", () => {
  it("GET returns 429 before invoking withTimeout when IP is throttled", async () => {
    const { withTimeout } = jest.requireMock("@/src/middleware/timeout");
    setRateLimitStore({
      async check() {
        return { allowed: false, remaining: 0, resetAt: Date.now() + 60, retryAfter: 30 };
      },
    });

    const res = await GET(makeGetRequest(`?address=${VALID_ADDRESS}`));
    expect(res.status).toBe(429);
    expect(withTimeout).not.toHaveBeenCalled();
  });

  it("POST returns 429 before invoking withTimeout when IP is throttled", async () => {
    const { withTimeout } = jest.requireMock("@/src/middleware/timeout");
    setRateLimitStore({
      async check() {
        return { allowed: false, remaining: 0, resetAt: Date.now() + 60, retryAfter: 30 };
      },
    });

    const res = await POST(
      makePostRequest({
        address: VALID_ADDRESS,
        challenge: VALID_CHALLENGE,
        signature: "valid-sig",
      }),
    );
    expect(res.status).toBe(429);
    expect(withTimeout).not.toHaveBeenCalled();
  });
});
