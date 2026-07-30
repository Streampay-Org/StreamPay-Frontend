import { GET, POST, resetWalletChallengeStoreForTesting } from "./route";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { logAccessEvent } from "@/src/middleware/accessLog";

jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

/**
 * Build a minimal Headers-like object for test assertions.
 */
function mockHeaders(init?: Record<string, string>): Record<string, string | null> {
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
      return new MockNextResponse(body, init) as unknown as import("next/server").NextResponse;
    }

    async json(): Promise<unknown> {
      return this.body;
    }

    async text(): Promise<string> {
      return this.body ? JSON.stringify(this.body) : "";
    }
  }

  return {
    NextResponse: MockNextResponse as unknown as typeof import("next/server").NextResponse,
    NextRequest: class MockNextRequest {},
  };
});

const VALID_ADDRESS = "GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7";
// Right shape, bad strkey checksum
const SHAPE_ONLY_ADDRESS = "GABC2345674567ABCDEFGHIJKLMNOPQRSTUVWXYZ2345674567ABCDEF";
const VALID_CHALLENGE = "streampay_auth_1721800000000_abc123xyz";

function makeGetRequest(params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams(params);
  return {
    nextUrl: { searchParams, pathname: "/api/auth/wallet" },
    headers: { get: () => null },
  } as unknown as import("next/server").NextRequest;
}

function makePostRequest(
  body: unknown,
  csrfCookie?: string,
  csrfHeader?: string,
) {
  return {
    json: async () => {
      if (body === "THROW") throw new Error("parse error");
      return body;
    },
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
    expect(body.challenge).toMatch(/^streampay_auth_/);
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

  it("returns paginated challenge records ordered by created_at and id", async () => {
    await GET(makeGetRequest({ address: VALID_ADDRESS }));
    await GET(makeGetRequest({ address: VALID_ADDRESS }));
    await GET(makeGetRequest({ address: VALID_ADDRESS }));

    const firstPage = await GET(
      makeGetRequest({ address: VALID_ADDRESS, limit: "2" }),
    );

    expect(firstPage.status).toBe(200);
    const firstBody = (firstPage as any).body;
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.hasNext).toBe(true);
    expect(firstBody.meta.nextCursor).toBeTruthy();
    expect(firstBody.data[0].created_at.localeCompare(firstBody.data[1].created_at)).toBeLessThanOrEqual(0);

    const secondPage = await GET(
      makeGetRequest({
        address: VALID_ADDRESS,
        limit: "2",
        cursor: firstBody.meta.nextCursor,
      }),
    );

    expect(secondPage.status).toBe(200);
    const secondBody = (secondPage as any).body;
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.meta.hasNext).toBe(false);
    expect(secondBody.meta.nextCursor).toBeNull();
  });

  it("returns 422 for a malformed cursor", async () => {
    const res = await GET(
      makeGetRequest({ address: VALID_ADDRESS, limit: "2", cursor: "not-a-cursor" }),
    );

    expect(res.status).toBe(422);
    expect((res as any).body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 422 when address has the right shape but a bad checksum", async () => {
    const res = await GET(makeGetRequest({ address: SHAPE_ONLY_ADDRESS }));
    expect(res.status).toBe(422);
    expect((res as any).body.error.code).toBe("VALIDATION_ERROR");
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

  it("returns 304 Not Modified when If-None-Match matches the strong ETag", async () => {
    // Freeze timestamps so challenge generation is deterministic across requests
    const origDateNow = Date.now.bind(Date);
    const origRandom = Math.random.bind(Math);
    Date.now = () => 1234567890000;
    Math.random = () => 0.5;

    try {
      // First request — capture the strong ETag
      const res1 = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      expect(res1.status).toBe(200);
      const etag = res1.headers.get("etag");
      expect(etag).toBeDefined();

      // Second request with identical conditions → same challenge → same ETag
      const req = makeGetRequest({ address: VALID_ADDRESS });
      req.headers.get = (name: string) => {
        if (name.toLowerCase() === "if-none-match") return etag;
        return null;
      };
      const res2 = await GET(req);
      expect(res2.status).toBe(304);
      // 304 must echo back the matching ETag
      expect(res2.headers.get("etag")).toBe(etag);
      expect(res2.headers.get("cache-control")).toBe("no-store");

      // 304 responses must have an empty body
      const text = await (res2 as any).text();
      expect(text).toBe("");
    } finally {
      Date.now = origDateNow;
      Math.random = origRandom;
    }
  });

  it("returns 304 Not Modified when If-None-Match is '*' (wildcard)", async () => {
    const req = makeGetRequest({ address: VALID_ADDRESS });
    req.headers.get = (name: string) => {
      if (name.toLowerCase() === "if-none-match") return "*";
      return null;
    };
    const res = await GET(req);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBeDefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 200 OK when If-None-Match does not match (different ETag)", async () => {
    const req = makeGetRequest({ address: VALID_ADDRESS });
    req.headers.get = (name: string) => {
      if (name.toLowerCase() === "if-none-match") return '"nonexistent-etag-value"';
      return null;
    };
    const res = await GET(req);
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBeDefined();
    // ETag should be different from the one we sent
    expect(etag).not.toBe('"nonexistent-etag-value"');
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 200 OK when If-None-Match contains a comma-separated list without a match", async () => {
    const req = makeGetRequest({ address: VALID_ADDRESS });
    req.headers.get = (name: string) => {
      if (name.toLowerCase() === "if-none-match")
        return '"etag-one", "etag-two", "etag-three"';
      return null;
    };
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeDefined();
  });

  it("returns 304 when If-None-Match list contains the matching ETag", async () => {
    // Freeze timestamps so challenge generation is deterministic across requests
    const origDateNow = Date.now.bind(Date);
    const origRandom = Math.random.bind(Math);
    Date.now = () => 1234567890000;
    Math.random = () => 0.5;

    try {
      // First request — capture the strong ETag
      const res1 = await GET(makeGetRequest({ address: VALID_ADDRESS }));
      expect(res1.status).toBe(200);
      const etag = res1.headers.get("etag");
      expect(etag).toBeDefined();

      // Second request with a comma-separated list that includes the ETag
      const req = makeGetRequest({ address: VALID_ADDRESS });
      req.headers.get = (name: string) => {
        if (name.toLowerCase() === "if-none-match")
          return `"other-etag", ${etag}, "another-etag"`;
        return null;
      };
      const res2 = await GET(req);
      expect(res2.status).toBe(304);
    } finally {
      Date.now = origDateNow;
      Math.random = origRandom;
    }
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
