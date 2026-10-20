/** @jest-environment node */
import { POST } from "./route";
import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetOrgQuotaStore } from "@/app/lib/org-quota-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";

jest.mock("@/app/lib/rate-limit", () => {
  const actual = jest.requireActual("@/app/lib/rate-limit") as any;
  return {
    ...actual,
    getClientIdentity: jest.fn(() => ({
      type: "ip" as const,
      value: "127.0.0.1",
      displayValue: "127.0.0.1",
    })),
  };
});

const VALID_STELLAR_KEY =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const VALID_ISSUER =
  "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

const validBody = {
  recipient: VALID_STELLAR_KEY,
  rate: "100",
  schedule: "month",
};

function makeRequest(body: object, idempotencyKey?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request("http://localhost/api/v2/streams", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/v2/streams — Idempotency and Validation", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    resetOrgQuotaStore();
    _resetAllowlistForTesting();
  });

  it("creates a stream without idempotency key (happy path)", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data.id).toMatch(/^stream-/);
    expect(body.data.status).toBe("draft");
    expect(body.data.recipient).toBe(validBody.recipient);
  });

  it("returns cached 201 for same key + same body", async () => {
    const key = "key-same-body";

    const res1 = await POST(makeRequest(validBody, key));
    expect(res1.status).toBe(201);
    const data1 = await res1.json();

    const res2 = await POST(makeRequest(validBody, key));
    expect(res2.status).toBe(201);
    const data2 = await res2.json();

    expect(data2).toEqual(data1);
  });

  it("returns 409 IDEMPOTENCY_CONFLICT for same key with different body", async () => {
    const key = "key-diff-body";

    const res1 = await POST(makeRequest(validBody, key));
    expect(res1.status).toBe(201);

    const res2 = await POST(
      makeRequest({ ...validBody, rate: "200" }, key),
    );
    expect(res2.status).toBe(409);

    const data = await res2.json();
    expect(data.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("returns cached response for same idempotency key", async () => {
    const key = "key-ttl";

    const res1 = await POST(makeRequest(validBody, key));
    expect(res1.status).toBe(201);
    const data1 = await res1.json();

    // Second request with same key returns the cached response
    const res2 = await POST(makeRequest(validBody, key));
    expect(res2.status).toBe(201);

    const data2 = await res2.json();
    expect(data2.data.id).toBe(data1.data.id);
  });

  describe("token allowlist & normalization", () => {
    it("stores and returns normalised token when allowlisted", async () => {
      const token = `USDC:${VALID_ISSUER}`;
      addAllowedToken(token);

      const res = await POST(makeRequest({ ...validBody, token }));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.token).toBe(token);
      expect(body.data.token).toBe(token);
    });

    it("returns 422 TOKEN_NOT_ALLOWED when token is not allowlisted", async () => {
      addAllowedToken(`USDC:${VALID_ISSUER}`);

      const res = await POST(
        makeRequest({ ...validBody, token: `OTHER:${VALID_ISSUER}` }),
      );
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_NOT_ALLOWED");
    });

    it("returns 422 INVALID_TOKEN when token format is malformed", async () => {
      const res = await POST(
        makeRequest({ ...validBody, token: "INVALID-FORMAT" }),
      );
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });
  });

  describe("edge cases", () => {
    it("returns 400 for invalid JSON body", async () => {
      const req = new Request("http://localhost/api/v2/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);

      const err = await res.json();
      expect(err.error.code).toBe("INVALID_REQUEST");
    });

    it("returns 422 for missing required fields", async () => {
      const res = await POST(makeRequest({ recipient: VALID_STELLAR_KEY }));
      expect(res.status).toBe(422);

      const err = await res.json();
      expect(err.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 with INVALID_STELLAR_KEY for invalid recipient key", async () => {
      const res = await POST(makeRequest({ ...validBody, recipient: "abc" }));
      expect(res.status).toBe(422);

      const err = await res.json();
      expect(err.error.code).toBe("VALIDATION_ERROR");
      expect(err.error.details).toBeDefined();
      expect(err.error.details[0].code).toBe("INVALID_STELLAR_KEY");
    });

    it("does not leak one key's cache to another key", async () => {
      const resA = await POST(makeRequest(validBody, "key-a"));
      const dataA = await resA.json();

      const resB = await POST(
        makeRequest(
          { recipient: VALID_STELLAR_KEY, rate: "50", schedule: "week" },
          "key-b",
        ),
      );
      const dataB = await resB.json();

      expect(dataA.data.id).not.toBe(dataB.data.id);
      expect(dataA.data.rate).not.toBe(dataB.data.rate);
    });
  });

  describe("createStreamCore org allowlist support", () => {
    it("accepts token when in org tokenAllowlist and rejects when not", async () => {
      const { createStreamCore } = await import("@/app/lib/stream-core");
      const allowedToken = `USDC:${VALID_ISSUER}`;
      const disallowedToken = `EURC:${VALID_ISSUER}`;

      const okRes = await createStreamCore({
        body: { ...validBody, token: allowedToken },
        org: { tokenAllowlist: [allowedToken] },
      });
      expect(okRes.ok).toBe(true);
      if (okRes.ok) {
        expect(okRes.stream.token).toBe(allowedToken);
      }

      const failRes = await createStreamCore({
        body: { ...validBody, token: disallowedToken },
        org: { tokenAllowlist: [allowedToken] },
      });
      expect(failRes.ok).toBe(false);
      if (!failRes.ok) {
        expect(failRes.code).toBe("TOKEN_NOT_ALLOWED");
        expect(failRes.status).toBe(422);
      }
    });
  });
});
