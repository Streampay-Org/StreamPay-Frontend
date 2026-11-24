import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  GET,
  POST,
  resetWalletChallengeStoreForTesting,
  seedWalletChallengeForTesting,
  getWalletChallengeStoreSizeForTesting,
  listWalletChallengesForTesting,
} from "./route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { logAccessEvent } from "@/src/middleware/accessLog";
import { encodeStellarPublicKey } from "@/app/lib/stellar-address";
import { tryAuthenticateRequest } from "@/app/lib/auth";

jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

/**
 * Build a minimal Headers-like object for test assertions.
 */
function mockHeaders(init?: Record<string, string>) {
  const store: Record<string, string> = {};
  if (init) {
    for (const [k, v] of Object.entries(init)) {
      store[k.toLowerCase()] = v;
    }
  }
  return {
    get: (k: string) => store[k.toLowerCase()] ?? null,
    set: (k: string, v: string) => {
      store[k.toLowerCase()] = v;
    },
    forEach: (cb: (v: string, k: string) => void) =>
      Object.entries(store).forEach(([k, v]) => cb(v, k)),
  };
}

jest.mock("next/server", () => {
  class MockNextResponse {
    readonly status: number;
    readonly headers: ReturnType<typeof mockHeaders>;
    readonly body: unknown;
    readonly ok: boolean;

    constructor(
      body?: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      this.status = init?.status ?? 200;
      this.headers = mockHeaders(init?.headers);
      if (typeof body === "string") {
        try {
          this.body = JSON.parse(body);
        } catch {
          this.body = body;
        }
      } else {
        this.body = body ?? null;
      }
      this.ok = this.status >= 200 && this.status < 300;
    }

    static json<T>(
      body: T,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      return new MockNextResponse(body, init);
    }

    async json(): Promise<unknown> {
      return this.body;
    }

    async text(): Promise<string> {
      return this.body ? JSON.stringify(this.body) : "";
    }
  }

  return {
    NextResponse: MockNextResponse,
    NextRequest: class MockNextRequest {},
  };
});

const VALID_ADDRESS = "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";
const ADDRESS_B = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADDRESS_C = "GBMIXCGFY4JOKI36TPVTOA2YUXHLZ5T6FVMSTXCUB57ZNAI4Y76XQWWM";
// Right shape, bad strkey checksum
const SHAPE_ONLY_ADDRESS = "GABC2345674567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345674567ABCDEF";
const CHALLENGE_PREFIX = "streampay-auth:v1:";
// A challenge that matches the issued shape, for POST validation tests.
const VALID_CHALLENGE = `${CHALLENGE_PREFIX}nKlQNln6SV4hJ6pm6jNMSBVlcqo7r8Pjcj9mqLA_oRg|http://localhost|2024-01-15T10:05:00.000Z`;

/**
 * Build a unique challenge in the issued `streampay-auth:v1:<nonce>|<origin>|<expiry>`
 * shape so seeded challenges pass POST body validation.
 */
function walletChallenge(tag: string): string {
  const nonce = `${tag}_`.padEnd(43, "A");
  return `${CHALLENGE_PREFIX}${nonce}|http://localhost|2099-01-01T00:00:00.000Z`;
}

function makeGetRequest(params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams(params);
  return {
    nextUrl: {
      searchParams,
      pathname: "/api/auth/wallet",
      origin: "http://localhost",
    },
    headers: { get: () => null },
    // This fixture supplies only the request fields consumed by the wallet route.
  } as unknown as import("next/server").NextRequest;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) controller.enqueue(encoded);
      controller.close();
    },
  });
}

function makePostRequest(
  body: unknown,
  csrfCookie?: string,
  csrfHeader?: string,
) {
  const text =
    body === "THROW"
      ? "{"
      : typeof body === "string"
        ? body
        : (JSON.stringify(body) ?? "");

  return {
    body: streamFromText(text),
    nextUrl: { pathname: "/api/auth/wallet" },
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === "x-csrf-token") return csrfHeader ?? null;
        if (lower === "x-forwarded-for") return null;
        if (lower === "x-real-ip") return null;
        return null;
      },
    },
    cookies: {
      get: (name: string) =>
        name === "csrf-token" ? (csrfCookie ? { value: csrfCookie } : undefined) : undefined,
    },
    // This fixture supplies only the request fields consumed by the wallet route.
  } as unknown as import("next/server").NextRequest;
}

function createTestWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(12);
  const address = encodeStellarPublicKey(rawPub);
  return { address, privateKey };
}

function signChallenge(challenge: string, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(challenge, "utf-8"), privateKey).toString("base64");
}

function validPostBody() {
  return {
    address: VALID_ADDRESS,
    challenge: VALID_CHALLENGE,
    signature: Buffer.alloc(64, 1).toString("base64"),
  };
}

function detailFields(res: unknown): string[] {
  return ((res as any).body.error.details as { field: string }[]).map(
    (d) => d.field,
  );
}

beforeEach(() => {
  resetRateLimitStore();
  jest.clearAllMocks();
  resetWalletChallengeStoreForTesting();
});

describe("GET /api/auth/wallet", () => {
  it("returns 200 with challenge, expires_at, strong ETag, and no-store Cache-Control", async () => {
    const res = await GET(makeGetRequest({ address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const body = (res as any).body;
    expect(typeof body.challenge).toBe("string");
    expect(body.challenge).toMatch(/^streampay-auth:v1:/);
    expect(logAccessEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/api/auth/wallet", status: 200 }),
    );
    expect(typeof body.expires_at).toBe("string");

    // Strong ETag — no W/ prefix, wrapped in double quotes
    const etag = res.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(etag).not.toMatch(/^W\//); // NOT a weak ETag

    // Cache-Control: no-store — challenges must never be cached
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 422 VALIDATION_ERROR with details when address is missing", async () => {
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(422);
    const body = (res as any).body;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(detailFields(res)).toEqual(["address"]);
  });

  it("rejects GET ?limit=10 with 400 UNSUPPORTED_QUERY and no challenge data", async () => {
    const res = await GET(
      makeGetRequest({ address: VALID_ADDRESS, limit: "10" }),
    );

    expect(res.status).toBe(400);
    const body = (res as any).body;
    expect(body.error.code).toBe("UNSUPPORTED_QUERY");
    // Regression proof: on main this branch returned other addresses'
    // live challenges under `data`. None of that may leak now.
    expect(body.data).toBeUndefined();
    expect(body.challenge).toBeUndefined();
    expect(body.meta).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects GET ?cursor=… with 400 UNSUPPORTED_QUERY", async () => {
    const res = await GET(
      makeGetRequest({ address: VALID_ADDRESS, cursor: "not-a-cursor" }),
    );

    expect(res.status).toBe(400);
    const body = (res as any).body;
    expect(body.error.code).toBe("UNSUPPORTED_QUERY");
    expect(body.data).toBeUndefined();
    expect(body.challenge).toBeUndefined();
  });

  it("returns 422 when address has the right shape but a bad checksum", async () => {
    const res = await GET(makeGetRequest({ address: SHAPE_ONLY_ADDRESS }));
    expect(res.status).toBe(422);
    expect((res as any).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("issues distinct CSPRNG challenges even in the same millisecond", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_721_800_000_000);
    try {
      const res1 = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      const res2 = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      const challenge1 = (res1 as any).body.challenge as string;
      const challenge2 = (res2 as any).body.challenge as string;

      // Same Date.now() tick, different (unguessable) values.
      expect(challenge1).not.toBe(challenge2);

      // Both carry ≥43 base64url characters right after the domain separator.
      for (const challenge of [challenge1, challenge2]) {
        expect(challenge.startsWith(CHALLENGE_PREFIX)).toBe(true);
        const nonce = challenge.slice(CHALLENGE_PREFIX.length).split("|")[0];
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps only the five newest challenges per address", async () => {
    const issued: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      issued.push((res as any).body.challenge);
    }

    expect(getWalletChallengeStoreSizeForTesting()).toBe(5);
    const stored = listWalletChallengesForTesting();
    expect(stored).toEqual(issued.slice(1));
    expect(stored).not.toContain(issued[0]);
  });

  it("prunes expired challenges on the next issuance", async () => {
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1_721_800_000_000);
    try {
      const first = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      const firstChallenge = (first as any).body.challenge as string;
      expect(getWalletChallengeStoreSizeForTesting()).toBe(1);

      // Jump past the 5-minute TTL.
      nowSpy.mockReturnValue(1_721_800_000_000 + 5 * 60 * 1000 + 1);
      const second = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      const secondChallenge = (second as any).body.challenge as string;

      expect(secondChallenge).not.toBe(firstChallenge);
      // The expired record was pruned before the new one was stored.
      expect(getWalletChallengeStoreSizeForTesting()).toBe(1);
      expect(listWalletChallengesForTesting()).toEqual([secondChallenge]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("evicts the oldest entries once WALLET_CHALLENGE_MAX is reached", async () => {
    const previousMax = process.env.WALLET_CHALLENGE_MAX;
    process.env.WALLET_CHALLENGE_MAX = "10";
    const addresses = [VALID_ADDRESS, ADDRESS_B, ADDRESS_C];
    const issued: string[] = [];
    try {
      // 3 addresses × 4 challenges = 12 insertions against a cap of 10;
      // the per-address cap (5) never fires here.
      for (let round = 0; round < 4; round++) {
        for (const address of addresses) {
          const res = await GET(makeGetRequest({ address }));
          issued.push((res as any).body.challenge);
          expect(getWalletChallengeStoreSizeForTesting()).toBeLessThanOrEqual(10);
        }
      }

      expect(getWalletChallengeStoreSizeForTesting()).toBe(10);
      // The two oldest records were evicted; the newest ten remain.
      expect(listWalletChallengesForTesting()).toEqual(issued.slice(2));
    } finally {
      if (previousMax === undefined) {
        delete process.env.WALLET_CHALLENGE_MAX;
      } else {
        process.env.WALLET_CHALLENGE_MAX = previousMax;
      }
    }
  });

  it("returns 200 with a body for If-None-Match on issuance, never 304", async () => {
    const first = await GET(makeGetRequest({ address: VALID_ADDRESS }));
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeDefined();

    for (const ifNoneMatch of ["*", etag]) {
      const req = makeGetRequest({ address: VALID_ADDRESS });
      req.headers.get = (name: string) =>
        name.toLowerCase() === "if-none-match" ? ifNoneMatch : null;
      const res = await GET(req);

      // A freshly issued challenge must always reach the client.
      expect(res.status).toBe(200);
      const responseBody = (res as any).body;
      expect(typeof responseBody.challenge).toBe("string");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("embeds the server origin and expiry in the challenge string", async () => {
    const res = await GET(makeGetRequest({ address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    const responseBody = (res as any).body;
    const challenge = responseBody.challenge as string;

    expect(challenge.startsWith(CHALLENGE_PREFIX)).toBe(true);
    const [nonce, origin, expiresAt] = challenge
      .slice(CHALLENGE_PREFIX.length)
      .split("|");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(origin).toBe("http://localhost");
    expect(expiresAt).toBe(responseBody.expires_at);
    // Printable ASCII, signable as one short string.
    expect(Buffer.byteLength(challenge, "ascii")).toBeLessThanOrEqual(256);
  });
});

describe("POST /api/auth/wallet validation", () => {
  it("returns 422 with a detail per missing field on an empty body", async () => {
    const res = await POST(makePostRequest({}, "csrf", "csrf"));
    expect(res.status).toBe(422);
    expect(detailFields(res).sort()).toEqual([
      "address",
      "challenge",
      "signature",
    ]);
  });

  it("returns 422 when fields have the wrong type", async () => {
    const res = await POST(
      makePostRequest(
        { address: 5, challenge: true, signature: null },
        "csrf",
        "csrf",
      ),
    );
    expect(res.status).toBe(422);
    expect(detailFields(res).sort()).toEqual([
      "address",
      "challenge",
      "signature",
    ]);
  });

  it("returns 422 when the challenge does not match the issued format", async () => {
    const res = await POST(
      makePostRequest({ ...validPostBody(), challenge: "ch" }, "csrf", "csrf"),
    );
    expect(res.status).toBe(422);
    expect(detailFields(res)).toEqual(["challenge"]);
  });

  it("returns 422 when signature is empty", async () => {
    const res = await POST(
      makePostRequest({ ...validPostBody(), signature: "" }, "csrf", "csrf"),
    );
    expect(res.status).toBe(422);
    expect(detailFields(res)).toEqual(["signature"]);
  });

  it("returns 422 when signature exceeds the maximum length", async () => {
    const res = await POST(
      makePostRequest(
        { ...validPostBody(), signature: "a".repeat(1025) },
        "csrf",
        "csrf",
      ),
    );
    expect(res.status).toBe(422);
    expect(detailFields(res)).toEqual(["signature"]);
  });

  it("returns 422 INVALID_JSON detail when the body is not valid JSON", async () => {
    const res = await POST(makePostRequest("THROW"));
    expect(res.status).toBe(422);
    const body = (res as any).body;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].code).toBe("INVALID_JSON");
  });

  it("returns 422 EMPTY_BODY when the request body is empty", async () => {
    const res = await POST(makePostRequest(""));
    expect(res.status).toBe(422);
    const body = (res as any).body;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].code).toBe("EMPTY_BODY");
  });

  it("returns 413 when a chunked request body exceeds the limit", async () => {
    const res = await POST(makePostRequest("x".repeat(300 * 1024), "csrf", "csrf"));
    expect(res.status).toBe(413);
    const body = (res as any).body;
    expect(body.error.code).toBe("REQUEST_TOO_LARGE");
    expect(body.error.message).toContain("262144-byte limit");
    expect(typeof body.error.request_id).toBe("string");
  });

  it("ignores unknown extra fields when the known fields are valid", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("extratest");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature, extra: "ignored" },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(200);
  });

  it("still sets ETag and Cache-Control headers after rate-limit reset", async () => {
    resetRateLimitStore();
    const res = await GET(makeGetRequest({ address: VALID_ADDRESS }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeDefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 429 with rate-limit error envelope (no ETag on error)", async () => {
    const req = () => makeGetRequest({ address: VALID_ADDRESS });

    // Exhaust the challenge limit (20/min)
    for (let i = 0; i < 20; i++) {
      await GET(req());
    }

    const limited = await GET(req());
    expect(limited.status).toBe(429);
    // Rate-limit error responses should not carry the success ETag header
    expect((limited as any).body.error.code).toBe("rate_limit_exceeded");
  });
});

describe("POST /api/auth/wallet", () => {
  it("returns 403 when csrf token is missing entirely", async () => {
    const res = await POST(makePostRequest(validPostBody()));
    expect(res.status).toBe(403);
  });

  it("returns 403 when csrf tokens are tampered/mismatched", async () => {
    const res = await POST(
      makePostRequest(
        validPostBody(),
        "valid_cookie_token",
        "tampered_header_token",
      ),
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with token for valid matching double-submit CSRF tokens", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("csrftest");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(200);
    const body = (res as any).body;
    expect(typeof body.token).toBe("string");
    expect(body.token_type).toBe("Bearer");
    expect(logAccessEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/api/auth/wallet", status: 200 }),
    );
  });

  it("returns 429 when rate limit is exceeded on POST (login)", async () => {
    const { address, privateKey } = createTestWallet();

    // Exhaust the login limit (5/min)
    for (let i = 0; i < 5; i++) {
      const challenge = walletChallenge(`rate${i}`);
      seedWalletChallengeForTesting({
        address,
        challenge,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const signature = signChallenge(challenge, privateKey);
      const res = await POST(
        makePostRequest(
          { address, challenge, signature },
          "securecsrf123",
          "securecsrf123",
        ),
      );
      expect(res.status).toBe(200);
    }

    // 6th request should be rate-limited
    const challenge6 = walletChallenge("rate6");
    seedWalletChallengeForTesting({
      address,
      challenge: challenge6,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature6 = signChallenge(challenge6, privateKey);
    const limited = await POST(
      makePostRequest(
        { address, challenge: challenge6, signature: signature6 },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(limited.status).toBe(429);
    expect((limited as any).body.error.code).toBe("rate_limit_exceeded");
    expect((limited as any).body.error.message).toBeTruthy();
    expect(typeof (limited as any).body.error.request_id).toBe("string");
  });
});

describe("POST /api/auth/wallet cryptographic verification & lifecycle", () => {
  it("Scenario 1: Valid challenge and a valid signature returns 200, JWT verifies via tryAuthenticateRequest and sub === address", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("scen1");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );

    expect(res.status).toBe(200);
    const body = (res as any).body;
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.token).toBe("string");
    expect(typeof body.expires_at).toBe("string");

    const authReq = {
      headers: {
        get: (h: string) => (h.toLowerCase() === "authorization" ? `Bearer ${body.token}` : null),
      },
    } as unknown as Request;
    const actor = tryAuthenticateRequest(authReq);
    expect(actor).not.toBeNull();
    expect(actor?.walletAddress).toBe(address);
  });

  it("Scenario 2: Signature from a different key returns 401", async () => {
    const walletA = createTestWallet();
    const walletB = createTestWallet();
    const challenge = walletChallenge("scen2");
    seedWalletChallengeForTesting({
      address: walletA.address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    // Signed by walletB's private key instead of walletA
    const signature = signChallenge(challenge, walletB.privateKey);

    const res = await POST(
      makePostRequest(
        { address: walletA.address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(401);
    expect((res as any).body.error.code).toBe("UNAUTHORIZED");
  });

  it("Scenario 3: Regression proof - signature: 'x' fails with 422 (or 401 on legacy), passes on main", async () => {
    const { address } = createTestWallet();
    const challenge = walletChallenge("scen3");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await POST(
      makePostRequest(
        { address, challenge, signature: "x" },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    // On main, this returned 200 because isValid was signature.length > 0.
    // Now it fails validation with 422 (not valid 64-byte base64) instead of 200.
    expect(res.status).toBe(422);
    expect((res as any).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("Scenario 4: Challenge never issued returns 401 CHALLENGE_UNKNOWN", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("unissued");
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(401);
    expect((res as any).body.error.code).toBe("CHALLENGE_UNKNOWN");
  });

  it("Scenario 5: Challenge past expires_at returns 401 CHALLENGE_EXPIRED", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("scen5");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() - 10_000).toISOString(), // expired
    });
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(401);
    expect((res as any).body.error.code).toBe("CHALLENGE_EXPIRED");
  });

  it("Scenario 6: Replay of a challenge that already succeeded returns 401 CHALLENGE_UNKNOWN", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("scen6");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    const req = () =>
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      );

    const first = await POST(req());
    expect(first.status).toBe(200);

    const replay = await POST(req());
    expect(replay.status).toBe(401);
    expect((replay as any).body.error.code).toBe("CHALLENGE_UNKNOWN");
  });

  it("Scenario 7: Challenge issued to address A, submitted for address B returns 401 CHALLENGE_ADDRESS_MISMATCH", async () => {
    const walletA = createTestWallet();
    const walletB = createTestWallet();
    const challenge = walletChallenge("scen7");
    // Challenge issued to walletA
    seedWalletChallengeForTesting({
      address: walletA.address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, walletB.privateKey);

    // Submitted with address B
    const res = await POST(
      makePostRequest(
        { address: walletB.address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(401);
    expect((res as any).body.error.code).toBe("CHALLENGE_ADDRESS_MISMATCH");
  });

  it("Scenario 8: Signature that is not 64 bytes, or not base64 returns 422 validation error", async () => {
    const { address } = createTestWallet();
    const challenge = walletChallenge("scen8");

    // Invalid base64
    const res1 = await POST(
      makePostRequest(
        { address, challenge, signature: "???notbase64!!!" },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res1.status).toBe(422);
    expect((res1 as any).body.error.code).toBe("VALIDATION_ERROR");

    // Valid base64, but only 32 bytes
    const res2 = await POST(
      makePostRequest(
        { address, challenge, signature: Buffer.alloc(32).toString("base64") },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res2.status).toBe(422);
    expect((res2 as any).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("Scenario 9: CSRF missing on a valid signature returns 403, and the challenge is not consumed", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("scen9");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    // Missing CSRF token
    const res403 = await POST(makePostRequest({ address, challenge, signature }));
    expect(res403.status).toBe(403);

    // Challenge must NOT have been consumed, so subsequent request with CSRF succeeds
    const res200 = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res200.status).toBe(200);
  });

  it("Scenario 10: expires_at matches the JWT exp within one second", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("scen10");
    seedWalletChallengeForTesting({
      address,
      challenge,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const signature = signChallenge(challenge, privateKey);

    const res = await POST(
      makePostRequest(
        { address, challenge, signature },
        "securecsrf123",
        "securecsrf123",
      ),
    );
    expect(res.status).toBe(200);
    const body = (res as any).body;

    const jwtDecoded = jwt.decode(body.token) as { exp: number };
    const jwtExpIso = new Date(jwtDecoded.exp * 1000).toISOString();
    const bodyExpMs = new Date(body.expires_at).getTime();
    const jwtExpMs = new Date(jwtExpIso).getTime();

    expect(Math.abs(bodyExpMs - jwtExpMs)).toBeLessThanOrEqual(1000);
  });

  it("Pin error precedence: Rate limit -> JSON & validation -> CSRF -> challenge lookup -> expiry -> signature", async () => {
    const { address, privateKey } = createTestWallet();
    const challenge = walletChallenge("precedence");

    // 1. Invalid JSON returns 422 before checking CSRF
    const resJson = await POST(makePostRequest("THROW"));
    expect(resJson.status).toBe(422);

    // 2. Validation error returns 422 before CSRF check
    const resVal = await POST(makePostRequest({ address: "invalid" }));
    expect(resVal.status).toBe(422);

    // 3. CSRF failure returns 403 before challenge lookup
    const resCsrf = await POST(
      makePostRequest({
        address,
        challenge,
        signature: Buffer.alloc(64).toString("base64"),
      }),
    );
    expect(resCsrf.status).toBe(403);

    // 4. Unknown challenge returns 401 CHALLENGE_UNKNOWN before signature verification
    const resUnknown = await POST(
      makePostRequest(
        {
          address,
          challenge,
          signature: Buffer.alloc(64).toString("base64"),
        },
        "csrf",
        "csrf",
      ),
    );
    expect(resUnknown.status).toBe(401);
    expect((resUnknown as any).body.error.code).toBe("CHALLENGE_UNKNOWN");
  });
});
