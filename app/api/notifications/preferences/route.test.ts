/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET, PUT } from "./route";
import { INSECURE_DEV_JWT_SECRET } from "@/app/lib/auth";

const TEST_SECRET = "test-secret-at-least-32-characters-long";
const WALLET_ADDRESS = "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@/app/lib/rate-limit", () => ({
  getClientIdentity: jest.fn(() => ({
    type: "wallet",
    value: WALLET_ADDRESS,
    displayValue: WALLET_ADDRESS,
  })),
  checkRateLimit: jest.fn(async () => ({ allowed: true, remaining: 10 })),
  rateLimitResponse: jest.fn((retryAfter: number) =>
    new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit exceeded" } }), {
      status: 429,
      headers: { "Retry-After": String(retryAfter) },
    }),
  ),
}));

jest.mock("@/app/lib/rate-limit-metrics", () => ({
  recordRequest: jest.fn(),
  recordThrottle: jest.fn(),
}));

jest.mock("@/app/lib/rate-limit-config", () => ({
  getLimitForRoute: jest.fn(() => "default"),
}));

function requestWithAuthorization({
  method = "GET",
  authorization,
  body,
}: {
  method?: string;
  authorization?: string;
  body?: string;
} = {}) {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/notifications/preferences", {
    method,
    headers,
    body,
  });
}

function signToken(payload: Record<string, unknown>, secret = TEST_SECRET) {
  return jwt.sign({ iss: "streampay", aud: "streampay-api", ...payload }, secret, {
    algorithm: "HS256",
    expiresIn: "15m",
  });
}

describe("GET /api/notifications/preferences", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    jest.clearAllMocks();
  });

  it("rejects a missing authorization header", async () => {
    const response = await GET(requestWithAuthorization());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("returns defaults for an authenticated actor with no saved preferences", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-defaults" });
    const response = await GET(requestWithAuthorization({ authorization: `Bearer ${token}` }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preferences).toMatchObject({
      userId: "actor-defaults",
      email: true,
      inApp: true,
      webhook: false,
      events: {
        streamCreated: true,
        streamCompleted: true,
        streamCancelled: true,
        paymentFailed: true,
        lowBalance: false,
      },
    });
  });

  it("rejects tokens signed with the insecure dev secret", async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-dev" }, INSECURE_DEV_JWT_SECRET);

    const response = await GET(requestWithAuthorization({ authorization: `Bearer ${token}` }));

    expect(response.status).toBe(401);
  });
});

describe("PUT /api/notifications/preferences", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    jest.clearAllMocks();
  });

  it("rejects malformed JSON", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-update" });
    const response = await PUT(
      requestWithAuthorization({
        method: "PUT",
        authorization: `Bearer ${token}`,
        body: "{ invalid json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });

  it("rejects invalid event payload keys and non-boolean fields", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-invalid" });
    const response = await PUT(
      requestWithAuthorization({
        method: "PUT",
        authorization: `Bearer ${token}`,
        body: JSON.stringify({ email: "yes", events: { unknown: true } }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_BODY" },
    });
  });

  it("merges partial updates into the existing preference set", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-merge" });
    const response = await PUT(
      requestWithAuthorization({
        method: "PUT",
        authorization: `Bearer ${token}`,
        body: JSON.stringify({
          email: false,
          inApp: true,
          events: {
            streamCreated: false,
            paymentFailed: false,
          },
        }),
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.preferences).toMatchObject({
      userId: "actor-merge",
      email: false,
      inApp: true,
      webhook: false,
      events: {
        streamCreated: false,
        streamCompleted: true,
        streamCancelled: true,
        paymentFailed: false,
        lowBalance: false,
      },
    });
  });
});
