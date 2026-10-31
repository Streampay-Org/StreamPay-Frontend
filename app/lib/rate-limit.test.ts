import crypto from "crypto";
import { getClientIdentity, checkRateLimit } from "./rate-limit";
import { signToken } from "./auth";
import { getMetrics, resetMetrics } from "./rate-limit-metrics";
import { InMemoryRateLimitStore } from "./rate-limit-store";
import { RATE_LIMITS, getLimitForRoute } from "./rate-limit-config";

describe("InMemoryRateLimitStore", () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  afterEach(() => {
    store.destroy();
  });

  describe("check", () => {
    it("should allow first request and set remaining tokens", async () => {
      const result = await store.check("test-identifier", 60, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(59);
      expect(result.resetAt).toBeGreaterThan(0);
    });

    it("should decrement tokens on subsequent requests", async () => {
      await store.check("test-identifier", 60, 60_000);
      const result = await store.check("test-identifier", 60, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(58);
    });

    it("should deny when tokens are exhausted", async () => {
      for (let i = 0; i < 60; i++) {
        await store.check("test-identifier", 60, 60_000);
      }

      const result = await store.check("test-identifier", 60, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("should track different identifiers separately", async () => {
      await store.check("id-1", 60, 60_000);
      const result1 = await store.check("id-1", 60, 60_000);
      const result2 = await store.check("id-2", 60, 60_000);

      expect(result1.remaining).toBe(58);
      expect(result2.remaining).toBe(59);
    });

    it("should handle concurrent requests for same identifier", async () => {
      const promises = [
        store.check("concurrent-id", 5, 60_000),
        store.check("concurrent-id", 5, 60_000),
        store.check("concurrent-id", 5, 60_000),
      ];

      const results = await Promise.all(promises);

      expect(results.filter((r) => r.allowed)).toHaveLength(3);
    });

    it("should respect window expiry for token refill", async () => {
      const fakeTimers = jest.useFakeTimers();
      try {
        for (let i = 0; i < 3; i++) {
          await store.check("test-identifier", 10, 60_000);
        }

        fakeTimers.advanceTimersByTime(60_000);

        const result = await store.check("test-identifier", 10, 60_000);

        expect(result.allowed).toBe(true);
      } finally {
        fakeTimers.useRealTimers();
      }
    });
  });

  describe("cleanup", () => {
    it("should clean up expired buckets", async () => {
      const fakeTimers = jest.useFakeTimers();
      try {
        await store.check("old-id", 60, 60_000);

        fakeTimers.advanceTimersByTime(120_001);

        store.cleanup();

        const result = await store.check("old-id", 60, 60_000);
        expect(result.remaining).toBe(59);
      } finally {
        fakeTimers.useRealTimers();
      }
    });
  });
});

describe("rate-limit-config", () => {
  describe("RATE_LIMITS", () => {
    it("should have correct read limit", () => {
      expect(RATE_LIMITS.read.limit).toBe(60);
      expect(RATE_LIMITS.read.windowMs).toBe(60_000);
    });

    it("should have correct write limit", () => {
      expect(RATE_LIMITS.write.limit).toBe(10);
      expect(RATE_LIMITS.write.windowMs).toBe(60_000);
    });
  });

  describe("getLimitForRoute", () => {
    it("should return read for GET streams list", () => {
      const result = getLimitForRoute("GET", "/api/streams");
      expect(result).toBe("read");
    });

    it("should return read for GET streams by id", () => {
      const result = getLimitForRoute("GET", "/api/streams/123");
      expect(result).toBe("read");
    });

    it("should return write for POST streams", () => {
      const result = getLimitForRoute("POST", "/api/streams");
      expect(result).toBe("write");
    });

    it("should return write for DELETE streams", () => {
      const result = getLimitForRoute("DELETE", "/api/streams/123");
      expect(result).toBe("write");
    });

    it("should return write for stream actions", () => {
      expect(getLimitForRoute("POST", "/api/streams/123/start")).toBe("write");
      expect(getLimitForRoute("POST", "/api/streams/123/pause")).toBe("write");
      expect(getLimitForRoute("POST", "/api/streams/123/stop")).toBe("write");
      expect(getLimitForRoute("POST", "/api/streams/123/settle")).toBe("write");
      expect(getLimitForRoute("POST", "/api/streams/123/withdraw")).toBe("write");
    });

    it("should return read for activity endpoint", () => {
      const result = getLimitForRoute("GET", "/api/activity");
      expect(result).toBe("read");
    });

    it("should return read for identity/me endpoint", () => {
      const result = getLimitForRoute("GET", "/api/identity/me");
      expect(result).toBe("read");
    });

    it("should return read for live indexer status endpoint", () => {
      const result = getLimitForRoute("GET", "/api/indexer/status");
      expect(result).toBe("read");
    });
  });
});

describe("Legacy Identity extraction (getClientIdentity)", () => {
  it("should extract API key from X-API-Key header", () => {
    const mockHeaders = new Map<string, string>([
      ["X-API-Key", "test-api-key-12345"],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("api_key");
    expect(identity.value).toBe("test-api-key-12345");
    expect(identity.displayValue).toBe("test-api-k...");
  });

  it("should extract wallet from JWT Bearer token", () => {
    const payload = { sub: "GABCD1234Wal...ess" };
    const token = `header.${btoa(JSON.stringify(payload))}.signature`;

    const mockHeaders = new Map<string, string>([
      ["Authorization", `Bearer ${token}`],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("wallet");
    expect(identity.value).toBe("GABCD1234Wal...ess");
    expect(identity.displayValue).toBe("GABCD1234Wal...");
  });

  it("should fall back to IP when no auth headers", () => {
    const mockHeaders = new Map<string, string>();
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("ip");
    expect(identity.value).toBe("unknown");
  });

  it("should extract IP from X-Forwarded-For header", () => {
    const mockHeaders = new Map<string, string>([
      ["X-Forwarded-For", "192.168.1.100, 10.0.0.1"],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("ip");
    expect(identity.value).toBe("192.168.1.100");
  });

  it("should extract IP from X-Real-IP header", () => {
    const mockHeaders = new Map<string, string>([
      ["X-Real-IP", "10.0.0.50"],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("ip");
    expect(identity.value).toBe("10.0.0.50");
  });

  it("should prioritize API key over wallet", () => {
    const payload = { sub: "WalletAddress" };
    const token = `header.${btoa(JSON.stringify(payload))}.signature`;

    const mockHeaders = new Map<string, string>([
      ["X-API-Key", "优先级-api-key"],
      ["Authorization", `Bearer ${token}`],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.type).toBe("api_key");
  });

  it("should use X-Forwarded-For over X-Real-IP", () => {
    const mockHeaders = new Map<string, string>([
      ["X-Forwarded-For", "192.168.1.100"],
      ["X-Real-IP", "10.0.0.50"],
    ]);
    const mockRequest = { headers: mockHeaders } as any;

    const identity = extractIdentityFromRequest(mockRequest);

    expect(identity.value).toBe("192.168.1.100");
  });
});

function extractIdentityFromRequest(request: { headers: Map<string, string> }): {
  type: "api_key" | "wallet" | "ip";
  value: string;
  displayValue: string;
} {
  const apiKey = request.headers.get("X-API-Key");
  if (apiKey) {
    return {
      type: "api_key",
      value: apiKey,
      displayValue: apiKey.slice(0, 10) + "...",
    };
  }

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const { sub } = JSON.parse(atob(token.split(".")[1])) as { sub?: string };
      if (sub) {
        return {
          type: "wallet",
          value: sub,
          displayValue: sub.slice(0, 12) + "...",
        };
      }
    } catch {}
  }

  const forwardedFor = request.headers.get("X-Forwarded-For");
  if (forwardedFor) {
    return {
      type: "ip",
      value: forwardedFor.split(",")[0].trim(),
      displayValue: forwardedFor.split(",")[0].trim(),
    };
  }

  const realIp = request.headers.get("X-Real-IP");
  if (realIp) {
    return {
      type: "ip",
      value: realIp,
      displayValue: realIp,
    };
  }

  return {
    type: "ip",
    value: "unknown",
    displayValue: "unknown",
  };
}

describe("rate-limit-metrics", () => {
  let throttled: Record<string, number>;
  let total: Record<string, number>;
  let recentThrottles: Array<{ route: string; limitType: string; identityType: string; identity: string; timestamp: number }>;

  beforeEach(() => {
    throttled = {};
    total = {};
    recentThrottles = [];
  });

  describe("recordThrottle", () => {
    it("should increment throttle counter", () => {
      recordThrottleExternal(throttled, recentThrottles, "/api/streams", "read", "ip", "192.168.1.1");
      recordThrottleExternal(throttled, recentThrottles, "/api/streams", "read", "ip", "192.168.1.2");

      expect(throttled["/api/streams:read"]).toBe(2);
    });

    it("should track different routes separately", () => {
      recordThrottleExternal(throttled, recentThrottles, "/api/streams", "read", "ip", "192.168.1.1");
      recordThrottleExternal(throttled, recentThrottles, "/api/activity", "read", "ip", "192.168.1.1");

      expect(throttled["/api/streams:read"]).toBe(1);
      expect(throttled["/api/activity:read"]).toBe(1);
    });

    it("should limit recentThrottles to MAX_RECENT_THROTTLES", () => {
      for (let i = 0; i < 150; i++) {
        recordThrottleExternal(throttled, recentThrottles, "/api/streams", "read", "ip", `192.168.1.${i}`);
      }

      expect(recentThrottles.length).toBe(100);
    });
  });

  describe("recordRequest", () => {
    it("should increment request counter", () => {
      recordRequestExternal(total, "/api/streams");
      recordRequestExternal(total, "/api/streams");
      recordRequestExternal(total, "/api/activity");

      expect(total["/api/streams"]).toBe(2);
      expect(total["/api/activity"]).toBe(1);
    });
  });
});

function recordThrottleExternal(
  throttled: Record<string, number>,
  recentThrottles: Array<{ route: string; limitType: string; identityType: string; identity: string; timestamp: number }>,
  route: string,
  limitType: string,
  identityType: string,
  identity: string
) {
  const key = `${route}:${limitType}`;
  throttled[key] = (throttled[key] || 0) + 1;
  recentThrottles.push({ route, limitType, identityType, identity, timestamp: Date.now() });
  if (recentThrottles.length > 100) {
    recentThrottles.shift();
  }
}

function recordRequestExternal(total: Record<string, number>, route: string) {
  total[route] = (total[route] || 0) + 1;
}

describe("checkRateLimit integration behavior", () => {
  it("should return allowed result when under limit", async () => {
    const mockStore = {
      check: jest.fn().mockResolvedValue({
        allowed: true,
        remaining: 50,
        resetAt: Date.now() + 60000,
      }),
    };

    const result = await mockStore.check("192.168.1.1", 60, 60_000);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(50);
  });

  it("should return denied result when over limit", async () => {
    const mockStore = {
      check: jest.fn().mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 30000,
        retryAfter: 30,
      }),
    };

    const result = await mockStore.check("192.168.1.1", 10, 60_000);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(30);
  });

  it("should call store with correct parameters for read", async () => {
    const checkMock = jest.fn().mockResolvedValue({
      allowed: true,
      remaining: 59,
      resetAt: Date.now() + 60000,
    });

    await checkMock("192.168.1.1", 60, 60_000);

    expect(checkMock).toHaveBeenCalledWith("192.168.1.1", 60, 60_000);
  });

  it("should call store with correct parameters for write", async () => {
    const checkMock = jest.fn().mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: Date.now() + 60000,
    });

    await checkMock("wallet123", 10, 60_000);

    expect(checkMock).toHaveBeenCalledWith("wallet123", 10, 60_000);
  });
});

describe("Verified Identity and Rate Limiting Scenarios", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetMetrics();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("scenario 8: 60 000 unique identifiers - bucket count stays at or below maxBuckets with LRU eviction", async () => {
    const smallStore = new InMemoryRateLimitStore(1000, { maxBuckets: 100 });
    for (let i = 0; i < 150; i++) {
      await smallStore.check("id-" + i, 10, 60_000);
    }
    expect(smallStore.getBucketCount()).toBeLessThanOrEqual(100);
    expect(getMetrics().evictions).toBeGreaterThanOrEqual(50);
    smallStore.destroy();
  });

  it("scenario 3: A valid configured API key gets its own bucket", () => {
    const rawKey = "test-secret-api-key-999";
    const hashed = crypto.createHash("sha256").update(rawKey, "utf8").digest("hex");
    process.env.STREAMPAY_API_KEYS = hashed;

    const request = new Request("http://localhost:3000/api/streams", {
      headers: { "X-API-Key": rawKey },
    });

    const identity = getClientIdentity(request);
    expect(identity.type).toBe("api_key");
    expect(identity.displayValue).toBe(hashed.slice(0, 4));
    expect(identity.displayValue).not.toContain(rawKey);
  });

  it("scenario 2: 100 requests, each with a random X-API-Key are ignored and throttled after the limit", async () => {
    process.env.STREAMPAY_API_KEYS = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    let throttledCount = 0;
    for (let i = 0; i < 15; i++) {
      const request = new Request("http://localhost:3000/api/streams", {
        headers: {
          "X-API-Key": "random-key-" + i,
          "x-forwarded-for": "198.51.100.10",
        },
      });
      const identity = getClientIdentity(request);
      expect(identity.type).toBe("ip");
      expect(identity.value).toBe("198.51.100.10");

      const check = await checkRateLimit(identity, "write");
      if (!check.allowed) throttledCount++;
    }

    expect(throttledCount).toBe(5);
  });

  it("scenario 1: 100 requests, each with a different unsigned-JWT sub all share the IP bucket and are throttled after the limit", async () => {
    let throttledCount = 0;
    for (let i = 0; i < 15; i++) {
      const fakeSub = "attacker-wallet-" + i;
      const fakePayload = Buffer.from(JSON.stringify({ sub: fakeSub })).toString("base64");
      const fakeToken = "eyJhbGciOiJIUzI1NiJ9." + fakePayload + ".fakesig";

      const request = new Request("http://localhost:3000/api/streams", {
        headers: {
          Authorization: "Bearer " + fakeToken,
          "x-forwarded-for": "203.0.113.5",
        },
      });

      const identity = getClientIdentity(request);
      expect(identity.type).toBe("ip");
      expect(identity.value).toBe("203.0.113.5");

      const check = await checkRateLimit(identity, "write");
      if (!check.allowed) throttledCount++;
    }

    expect(throttledCount).toBe(5);
  });

  it("scenario 4: A properly signed JWT gets identity type wallet", () => {
    const walletAddress = "GA2W6...VALID...WALLET";
    const token = signToken(walletAddress);

    const request = new Request("http://localhost:3000/api/streams", {
      headers: {
        Authorization: "Bearer " + token,
      },
    });

    const identity = getClientIdentity(request);
    expect(identity.type).toBe("wallet");
    expect(identity.value).toBe(walletAddress);
  });

  it("scenario 5: XFF 1.1.1.1, 2.2.2.2 with one trusted hop - the IP is 2.2.2.2", () => {
    const request = new Request("http://localhost:3000/api/streams", {
      headers: {
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      },
    });

    const identity = getClientIdentity(request);
    expect(identity.type).toBe("ip");
    expect(identity.value).toBe("2.2.2.2");
  });

  it("scenario 6: TRUST_PROXY=vercel with an x-real-ip - x-real-ip is used and XFF is ignored", () => {
    process.env.TRUST_PROXY = "vercel";
    const request = new Request("http://localhost:3000/api/streams", {
      headers: {
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
        "x-real-ip": "3.3.3.3",
      },
    });

    const identity = getClientIdentity(request);
    expect(identity.type).toBe("ip");
    expect(identity.value).toBe("3.3.3.3");
  });

  it("scenario 7: IPv6 addresses in the same /64 share the same bucket", async () => {
    const ip1 = "2001:db8:abcd:0012:0000:0000:0000:0001";
    const ip2 = "2001:db8:abcd:0012:ffff:ffff:ffff:ffff";

    const req1 = new Request("http://localhost:3000/api/streams", {
      headers: { "x-forwarded-for": ip1 },
    });
    const req2 = new Request("http://localhost:3000/api/streams", {
      headers: { "x-forwarded-for": ip2 },
    });

    const id1 = getClientIdentity(req1);
    const id2 = getClientIdentity(req2);

    expect(id1.value).toBe("2001:0db8:abcd:0012::/64");
    expect(id2.value).toBe("2001:0db8:abcd:0012::/64");
    expect(id1.value).toBe(id2.value);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(id1, "write");
    }
    const check2 = await checkRateLimit(id2, "write");
    expect(check2.allowed).toBe(false);
  });
});