import {
  checkIpRateLimit,
  rateLimitResponse,
  resolveCorrelationId,
  WALLET_RATE_LIMITS,
} from "./rateLimitIp";
import { InMemoryRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetMetrics } from "@/app/lib/rate-limit-metrics";

jest.mock("next/server", () => ({
  NextResponse: {
    json: <T>(body: T, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      body,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

function makeRequest(
  ipHeader?: string,
  ipValue?: string,
  extraHeaders?: Record<string, string>
) {
  const headers = new Map<string, string>();
  if (ipHeader && ipValue) {
    headers.set(ipHeader, ipValue);
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return {
    headers,
    nextUrl: { pathname: "/api/auth/wallet" },
  } as any;
}

beforeEach(() => {
  resetMetrics();
  jest.restoreAllMocks();
});

describe("WALLET_RATE_LIMITS", () => {
  it("should have correct challenge limit", () => {
    expect(WALLET_RATE_LIMITS.challenge.limit).toBe(20);
    expect(WALLET_RATE_LIMITS.challenge.windowMs).toBe(60_000);
  });

  it("should have correct login limit", () => {
    expect(WALLET_RATE_LIMITS.login.limit).toBe(5);
    expect(WALLET_RATE_LIMITS.login.windowMs).toBe(60_000);
  });
});

describe("resolveCorrelationId", () => {
  it("uses x-request-id when present", () => {
    const req = makeRequest(undefined, undefined, { "x-request-id": "req_abc" });
    expect(resolveCorrelationId(req)).toBe("req_abc");
  });

  it("falls back to x-correlation-id", () => {
    const req = makeRequest(undefined, undefined, {
      "x-correlation-id": "corr_xyz",
    });
    expect(resolveCorrelationId(req)).toBe("corr_xyz");
  });

  it("generates a req_ id when no correlation headers exist", () => {
    const req = makeRequest();
    expect(resolveCorrelationId(req)).toMatch(/^req_/);
  });

  it("trims whitespace from forwarded ids", () => {
    const req = makeRequest(undefined, undefined, {
      "x-request-id": "  req_trim  ",
    });
    expect(resolveCorrelationId(req)).toBe("req_trim");
  });
});

describe("checkIpRateLimit", () => {
  it("should allow requests under the limit", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();
    const result = await checkIpRateLimit(req, "login", store);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it("should deny when limit is exhausted for login", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();
    const limit = WALLET_RATE_LIMITS.login.limit;

    for (let i = 0; i < limit; i++) {
      const res = await checkIpRateLimit(req, "login", store);
      expect(res.allowed).toBe(true);
    }

    const blocked = await checkIpRateLimit(req, "login", store);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeDefined();
    expect(blocked.retryAfter).toBeGreaterThan(0);
    store.destroy();
  });

  it("should deny when limit is exhausted for challenge", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();
    const limit = WALLET_RATE_LIMITS.challenge.limit;

    for (let i = 0; i < limit; i++) {
      const res = await checkIpRateLimit(req, "challenge", store);
      expect(res.allowed).toBe(true);
    }

    const blocked = await checkIpRateLimit(req, "challenge", store);
    expect(blocked.allowed).toBe(false);
    store.destroy();
  });

  it("should track different IPs separately", async () => {
    const store = new InMemoryRateLimitStore();
    const req1 = makeRequest("x-forwarded-for", "1.1.1.1");
    const req2 = makeRequest("x-forwarded-for", "2.2.2.2");

    for (let i = 0; i < 5; i++) {
      await checkIpRateLimit(req1, "login", store);
    }

    const result1 = await checkIpRateLimit(req1, "login", store);
    expect(result1.allowed).toBe(false);

    const result2 = await checkIpRateLimit(req2, "login", store);
    expect(result2.allowed).toBe(true);
    store.destroy();
  });

  it("should use x-forwarded-for header for IP extraction", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest("x-forwarded-for", "203.0.113.50, 10.0.0.1");
    const result = await checkIpRateLimit(req, "login", store);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it("should use x-real-ip as fallback", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest("x-real-ip", "10.0.0.99");
    const result = await checkIpRateLimit(req, "login", store);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it("should default to 'unknown' when no IP headers present", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();
    const result = await checkIpRateLimit(req, "login", store);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it("should recover after the window expires", async () => {
    jest.useFakeTimers();
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();

    for (let i = 0; i < 5; i++) {
      await checkIpRateLimit(req, "login", store);
    }

    const blocked = await checkIpRateLimit(req, "login", store);
    expect(blocked.allowed).toBe(false);

    jest.advanceTimersByTime(60_001);

    const recovered = await checkIpRateLimit(req, "login", store);
    expect(recovered.allowed).toBe(true);

    jest.useRealTimers();
    store.destroy();
  });

  it("emits structured throttle log with correlation id when blocked", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const store = new InMemoryRateLimitStore();
    const req = makeRequest("x-forwarded-for", "9.9.9.9", {
      "x-request-id": "req_throttle_test",
    });

    for (let i = 0; i < 5; i++) {
      await checkIpRateLimit(req, "login", store);
    }
    await checkIpRateLimit(req, "login", store);

    const walletLog = warn.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0]));
        } catch {
          return null;
        }
      })
      .find((p) => p?.event === "wallet_ip_rate_limit_exceeded");

    expect(walletLog).toBeDefined();
    expect(walletLog.request_id).toBe("req_throttle_test");
    expect(walletLog.limitType).toBe("login");
    expect(walletLog.identityDisplay).toBe("9.9.9.9");

    store.destroy();
  });

  it("ignores blank x-forwarded-for and falls through to x-real-ip", async () => {
    const store = new InMemoryRateLimitStore();
    const headers = new Map<string, string>();
    headers.set("x-forwarded-for", "  , ");
    headers.set("x-real-ip", "198.51.100.1");
    const req = {
      headers,
      nextUrl: { pathname: "/api/auth/wallet" },
    } as any;

    // Exhaust login for this IP, then confirm a different blank-forwarded IP
    // still shares the same bucket as x-real-ip.
    for (let i = 0; i < 5; i++) {
      await checkIpRateLimit(req, "login", store);
    }
    const blocked = await checkIpRateLimit(req, "login", store);
    expect(blocked.allowed).toBe(false);
    store.destroy();
  });
});

describe("rateLimitResponse", () => {
  it("should return 429 with correct error envelope", () => {
    const res = rateLimitResponse(30);
    expect(res.status).toBe(429);
    expect((res as any).body.error.code).toBe("rate_limit_exceeded");
    expect((res as any).body.error.message).toBe(
      "Too many requests. Please try again later."
    );
    expect(typeof (res as any).body.error.request_id).toBe("string");
    expect((res as any).body.error.request_id.length).toBeGreaterThan(0);
  });

  it("should set Retry-After and x-request-id headers", () => {
    const req = makeRequest(undefined, undefined, {
      "x-request-id": "req_header_echo",
    });
    const res = rateLimitResponse(45, req);
    expect((res as any).headers["Retry-After"]).toBe("45");
    expect((res as any).headers["x-request-id"]).toBe("req_header_echo");
    expect((res as any).body.error.request_id).toBe("req_header_echo");
  });
});

describe("rate limit isolation between limit types", () => {
  it("should track challenge and login limits separately for same IP", async () => {
    const store = new InMemoryRateLimitStore();
    const req = makeRequest();

    for (let i = 0; i < 20; i++) {
      const res = await checkIpRateLimit(req, "challenge", store);
      expect(res.allowed).toBe(true);
    }

    const challengeBlocked = await checkIpRateLimit(req, "challenge", store);
    expect(challengeBlocked.allowed).toBe(false);

    const loginAllowed = await checkIpRateLimit(req, "login", store);
    expect(loginAllowed.allowed).toBe(true);

    store.destroy();
  });
});
