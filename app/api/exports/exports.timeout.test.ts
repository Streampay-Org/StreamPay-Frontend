/**
 * app/api/exports/exports.timeout.test.ts
 *
 * Focused tests for the per-request timeout behaviour of
 * GET and POST /api/exports.
 *
 * Strategy: replace `withTimeout` from `src/middleware/timeout` with a
 * controllable stub so we can trigger a timeout synchronously without
 * using real timers.  This keeps the tests fast and deterministic.
 *
 * Coverage
 * ─────────
 * • POST returns 504 with GATEWAY_TIMEOUT when the deadline passes.
 * • GET returns 504 with GATEWAY_TIMEOUT when the deadline passes.
 * • 504 body shape matches the standard error envelope.
 * • POST returns 201 normally when within the deadline.
 * • GET returns 200 normally when within the deadline.
 */

import jwt from "jsonwebtoken";
import { POST, GET } from "./route";
import { resetDb } from "@/app/lib/db";
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
    EXPORTS_TIMEOUT_MS: 15_000,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

function authRequest(url: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(url, { headers });
}

function makeToken(walletAddress: string, role = "user"): string {
  return jwt.sign(
    { sub: walletAddress, role, iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  __simulateTimeout = false;
  jest.clearAllMocks();
  resetDb();
  resetRateLimitStore();
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

describe("POST /api/exports — timeout", () => {
  it("returns 504 when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await POST(authRequest("http://localhost/api/exports", token));
    expect(res.status).toBe(504);
  });

  it("504 body has GATEWAY_TIMEOUT error code", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await POST(authRequest("http://localhost/api/exports", token));
    const body = await res.json();
    expect(body.error.code).toBe("GATEWAY_TIMEOUT");
  });

  it("504 body matches the standard error envelope shape", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await POST(authRequest("http://localhost/api/exports", token));
    const body = await res.json();
    expect(body).toMatchObject({
      error: {
        code: "GATEWAY_TIMEOUT",
        message: expect.stringContaining("deadline"),
        request_id: expect.any(String),
      },
    });
  });

  it("returns 201 normally when within the deadline", async () => {
    const token = makeToken("GOWNER1");
    const res = await POST(authRequest("http://localhost/api/exports", token));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
  });
});

describe("GET /api/exports — timeout", () => {
  it("returns 504 when the deadline is exceeded", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await GET(authRequest("http://localhost/api/exports", token));
    expect(res.status).toBe(504);
  });

  it("504 body has GATEWAY_TIMEOUT error code", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await GET(authRequest("http://localhost/api/exports", token));
    const body = await res.json();
    expect(body.error.code).toBe("GATEWAY_TIMEOUT");
  });

  it("504 body matches the standard error envelope shape", async () => {
    __simulateTimeout = true;
    const token = makeToken("GOWNER1");
    const res = await GET(authRequest("http://localhost/api/exports", token));
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
    const token = makeToken("GOWNER1");
    const res = await GET(authRequest("http://localhost/api/exports", token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");
  });
});
