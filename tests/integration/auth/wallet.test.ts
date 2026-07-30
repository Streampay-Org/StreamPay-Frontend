import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/auth/wallet/route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

const VALID_ADDRESS =
  "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";

function walletRequest(
  method: "GET" | "POST",
  body?: Record<string, string>,
  csrfToken?: string,
) {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.42",
    "x-request-id": "req-wallet-integration",
  });

  if (body) {
    headers.set("content-type", "application/json");
  }
  if (csrfToken) {
    headers.set("cookie", `csrf-token=${csrfToken}`);
    headers.set("x-csrf-token", csrfToken);
  }

  return new NextRequest("http://localhost/api/auth/wallet", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("wallet authentication integration", () => {
  beforeEach(() => {
    resetRateLimitStore();
  });

  afterEach(() => {
    resetRateLimitStore();
  });

  it("issues a challenge and exchanges it for an access token", async () => {
    const challengeResponse = await GET(
      new NextRequest(
        `http://localhost/api/auth/wallet?address=${VALID_ADDRESS}`,
        {
          headers: {
            "x-forwarded-for": "203.0.113.42",
            "x-request-id": "req-wallet-integration",
          },
        },
      ),
    );

    expect(challengeResponse.status).toBe(200);
    const challengeBody = await challengeResponse.json();
    expect(challengeBody.challenge).toMatch(/^streampay_auth_/);
    expect(Date.parse(challengeBody.expires_at)).toBeGreaterThan(Date.now());

    const csrfToken = "wallet-integration-csrf";
    const verifyResponse = await POST(
      walletRequest(
        "POST",
        {
          address: VALID_ADDRESS,
          challenge: challengeBody.challenge,
          signature: "integration-signature",
        },
        csrfToken,
      ),
    );

    expect(verifyResponse.status).toBe(200);
    await expect(verifyResponse.json()).resolves.toEqual({
      token: expect.stringMatching(/^tok_/),
      expires_at: expect.any(String),
    });
  });

  it("rejects a valid challenge when the CSRF tokens do not match", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/auth/wallet", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "csrf-token=cookie-token",
          "x-csrf-token": "header-token",
          "x-forwarded-for": "203.0.113.43",
          "x-request-id": "req-wallet-csrf",
        },
        body: JSON.stringify({
          address: VALID_ADDRESS,
          challenge: "streampay_auth_1721800000000_integration",
          signature: "integration-signature",
        }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "CSRF token mismatch.",
        request_id: expect.any(String),
      },
    });
  });
});
