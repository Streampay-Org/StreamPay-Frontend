import {
  GET,
  POST,
  resetWalletChallengeStoreForTesting,
  getWalletChallengeStoreSizeForTesting,
  listWalletChallengesForTesting,
} from "./route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { logAccessEvent } from "@/src/middleware/accessLog";

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
      this.body = body ?? null;
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

function validPostBody() {
  return {
    address: VALID_ADDRESS,
    challenge: VALID_CHALLENGE,
    signature: "validbase64sig==",
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
    const res = await POST(
      makePostRequest(
        { ...validPostBody(), extra: "ignored" },
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
    const res = await POST(
      makePostRequest(validPostBody(), "securecsrf123", "securecsrf123"),
    );
    expect(res.status).toBe(200);
    const body = (res as any).body;
    expect(typeof body.token).toBe("string");
    expect(logAccessEvent).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/api/auth/wallet", status: 200 }),
    );
  });

  it("returns 429 when rate limit is exceeded on POST (login)", async () => {
    const req = () =>
      makePostRequest(validPostBody(), "securecsrf123", "securecsrf123");

    // Exhaust the login limit (5/min)
    for (let i = 0; i < 5; i++) {
      const res = await POST(req());
      expect(res.status).toBe(200);
    }

    // 6th request should be rate-limited
    const limited = await POST(req());
    expect(limited.status).toBe(429);
    expect((limited as any).body.error.code).toBe("rate_limit_exceeded");
    expect((limited as any).body.error.message).toBeTruthy();
    expect(typeof (limited as any).body.error.request_id).toBe("string");
  });
});

describe("GET /api/auth/wallet rate limiting", () => {
  it("returns 429 when rate limit is exceeded on GET (challenge)", async () => {
    const req = () => makeGetRequest({ address: VALID_ADDRESS });

    // Exhaust the challenge limit (20/min)
    for (let i = 0; i < 20; i++) {
      const res = await GET(req());
      expect(res.status).toBe(200);
    }

    // 21st request should be rate-limited
    const limited = await GET(req());
    expect(limited.status).toBe(429);
    expect((limited as any).body.error.code).toBe("rate_limit_exceeded");
  });
});
