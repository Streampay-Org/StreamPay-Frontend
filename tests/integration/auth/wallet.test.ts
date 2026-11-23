import crypto from "crypto";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/auth/wallet/route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { encodeStellarPublicKey } from "@/app/lib/stellar-address";

const VALID_ADDRESS =
  "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";

/** A real ed25519 wallet so the route's signature verification can pass. */
function createTestWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  return { address: encodeStellarPublicKey(rawPub), privateKey };
}

function signChallenge(challenge: string, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(challenge, "utf-8"), privateKey).toString("base64");
}

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
    const wallet = createTestWallet();
    const challengeResponse = await GET(
      new NextRequest(
        `http://localhost/api/auth/wallet?address=${wallet.address}`,
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
    expect(challengeBody.challenge).toMatch(/^streampay-auth:v1:/);
    expect(Date.parse(challengeBody.expires_at)).toBeGreaterThan(Date.now());

    const csrfToken = "wallet-integration-csrf";
    const verifyResponse = await POST(
      walletRequest(
        "POST",
        {
          address: wallet.address,
          challenge: challengeBody.challenge,
          signature: signChallenge(challengeBody.challenge, wallet.privateKey),
        },
        csrfToken,
      ),
    );

    expect(verifyResponse.status).toBe(200);
    await expect(verifyResponse.json()).resolves.toEqual(
      expect.objectContaining({
        token: expect.any(String),
        token_type: "Bearer",
        expires_at: expect.any(String),
      }),
    );
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
          challenge: "streampay-auth:v1:nKlQNln6SV4hJ6pm6jNMSBVlcqo7r8Pjcj9mqLA_oRg|http://localhost|2024-01-15T10:05:00.000Z",
          signature: Buffer.alloc(64, 1).toString("base64"),
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
