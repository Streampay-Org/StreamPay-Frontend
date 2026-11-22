/**
 * @jest-environment node
 */

import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { signToken, tryAuthenticateRequest } from "@/app/lib/auth";
import { getTokenDenylist, resetTokenDenylist } from "@/app/lib/token-denylist";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

const TEST_SECRET = "test-secret-at-least-32-characters-long";
const PREVIOUS_SECRET = "previous-secret-at-least-32-characters-long";
const WALLET_ADDRESS = "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";

const originalJwtSecret = process.env.JWT_SECRET;
const originalPreviousSecret = process.env.JWT_PREVIOUS_SECRET;

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  process.env.JWT_PREVIOUS_SECRET = PREVIOUS_SECRET;
});

afterAll(() => {
  if (originalJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwtSecret;
  }
  if (originalPreviousSecret === undefined) {
    delete process.env.JWT_PREVIOUS_SECRET;
  } else {
    process.env.JWT_PREVIOUS_SECRET = originalPreviousSecret;
  }
});

beforeEach(() => {
  resetTokenDenylist();
  resetRateLimitStore();
});

function logoutRequest(token?: string, ip = "203.0.113.10"): NextRequest {
  return new NextRequest("http://localhost/api/auth/logout", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

function authRequest(token: string): Request {
  return new Request("http://localhost/api/streams", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("POST /api/auth/logout", () => {
  it("revokes the presented token and returns 204", async () => {
    const token = signToken(WALLET_ADDRESS);
    const claims = jwt.decode(token) as { jti: string; exp: number };

    expect(tryAuthenticateRequest(authRequest(token))).not.toBeNull();

    const res = await POST(logoutRequest(token));

    expect(res.status).toBe(204);
    expect(getTokenDenylist().isRevoked(claims.jti)).toBe(true);
    expect(tryAuthenticateRequest(authRequest(token))).toBeNull();
  });

  it("is idempotent when the token was already revoked", async () => {
    const token = signToken(WALLET_ADDRESS);

    expect((await POST(logoutRequest(token))).status).toBe(204);
    expect((await POST(logoutRequest(token))).status).toBe(204);
  });

  it("handles concurrent logouts for the same token", async () => {
    const token = signToken(WALLET_ADDRESS);

    const responses = await Promise.all([
      POST(logoutRequest(token)),
      POST(logoutRequest(token)),
    ]);

    expect(responses.map((res) => res.status)).toEqual([204, 204]);
  });

  it("returns a 401 envelope when the Authorization header is missing", async () => {
    const res = await POST(logoutRequest());

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(typeof body.error.request_id).toBe("string");
  });

  it("returns a 401 envelope for an invalid token", async () => {
    const res = await POST(logoutRequest("not-a-jwt"));

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("returns a 401 envelope for an expired token", async () => {
    const expired = jwt.sign(
      { sub: WALLET_ADDRESS, iss: "streampay", aud: "streampay-api" },
      TEST_SECRET,
      { algorithm: "HS256", expiresIn: "-1s" },
    );

    const res = await POST(logoutRequest(expired));

    expect(res.status).toBe(401);
  });

  it("accepts a token without a jti and leaves it valid", async () => {
    const legacy = jwt.sign(
      { sub: WALLET_ADDRESS, iss: "streampay", aud: "streampay-api" },
      TEST_SECRET,
      {
        algorithm: "HS256",
        expiresIn: "15m",
        header: { alg: "HS256", kid: "streampay-current" },
      },
    );

    const res = await POST(logoutRequest(legacy));

    expect(res.status).toBe(204);
    expect(tryAuthenticateRequest(authRequest(legacy))).not.toBeNull();
  });

  it("revokes tokens signed with a rotated key", async () => {
    const token = jwt.sign(
      { sub: WALLET_ADDRESS, iss: "streampay", aud: "streampay-api", jti: "rotated-jti" },
      PREVIOUS_SECRET,
      {
        algorithm: "HS256",
        expiresIn: "15m",
        header: { alg: "HS256", kid: "streampay-previous" },
      },
    );

    const res = await POST(logoutRequest(token));

    expect(res.status).toBe(204);
    expect(getTokenDenylist().isRevoked("rotated-jti")).toBe(true);
  });

  it("rate-limits repeated logout attempts per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await POST(logoutRequest(signToken(WALLET_ADDRESS)));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual([204, 204, 204, 204, 204]);
    expect(statuses[5]).toBe(429);
  });
});
