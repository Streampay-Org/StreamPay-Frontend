import { NextRequest } from "next/server";
import { resetRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import {
  applyRateLimit,
  streamsRateLimit,
  walletAuthRateLimit,
} from "./rateLimit";

describe("streamsRateLimit", () => {
  afterEach(() => {
    resetRateLimitStore();
  });

  describe("GET requests", () => {
    it("allows request when under rate limit", async () => {
      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");

      expect(result.allowed).toBe(true);
      expect(result.response).toBeUndefined();
    });

    it("rejects request when rate limit exceeded", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 1234567890,
          retryAfter: 60,
        }),
      });

      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");

      expect(result.allowed).toBe(false);
      expect(result.response).toBeDefined();
      expect(result.response!.status).toBe(429);
    });

    it("returns 429 response with Retry-After header", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 1234567890,
          retryAfter: 30,
        }),
      });

      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");

      expect(result.response!.headers.get("Retry-After")).toBe("30");
    });

    it("uses read limit for GET /api/streams", async () => {
      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");

      expect(result.allowed).toBe(true);
    });
  });

  describe("POST requests", () => {
    it("allows request when under write rate limit", async () => {
      const req = new Request("http://localhost/api/streams", { method: "POST" });
      const result = await streamsRateLimit(req, "POST", "/api/streams");

      expect(result.allowed).toBe(true);
    });

    it("rejects POST when write rate limit exceeded", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 1234567890,
          retryAfter: 45,
        }),
      });

      const req = new Request("http://localhost/api/streams", { method: "POST" });
      const result = await streamsRateLimit(req, "POST", "/api/streams");

      expect(result.allowed).toBe(false);
      expect(result.response!.status).toBe(429);
    });
  });

  describe("identity extraction", () => {
    it("identifies by API key when X-API-Key is present", async () => {
      const req = new Request("http://localhost/api/streams", {
        headers: { "X-API-Key": "test-key-123" },
      });

      // First request uses a fresh store, so it should be allowed
      const result = await streamsRateLimit(req, "GET", "/api/streams");
      expect(result.allowed).toBe(true);
    });

    it("identifies by wallet JWT when present", async () => {
      const payload = { sub: "GABCDEF1234567890" };
      const token = `header.${btoa(JSON.stringify(payload))}.signature`;

      const req = new Request("http://localhost/api/streams", {
        headers: { authorization: `Bearer ${token}` },
      });

      const result = await streamsRateLimit(req, "GET", "/api/streams");
      expect(result.allowed).toBe(true);
    });

    it("falls back to IP when no auth headers", async () => {
      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");
      expect(result.allowed).toBe(true);
    });
  });

  describe("error response format", () => {
    it("includes rate_limit_exceeded error code in 429 response", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 1234567890,
          retryAfter: 60,
        }),
      });

      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");
      const body = await result.response!.json();

      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(body.error.message).toBe("Rate limit exceeded. Please try again later.");
    });

    it("includes request_id in 429 response", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 1234567890,
          retryAfter: 60,
        }),
      });

      const req = new Request("http://localhost/api/streams");
      const result = await streamsRateLimit(req, "GET", "/api/streams");
      const body = await result.response!.json();

      expect(body.error.request_id).toBeDefined();
      expect(typeof body.error.request_id).toBe("string");
    });
  });

  describe("per-user isolation", () => {
    it("tracks different API keys separately", async () => {
      const req1 = new Request("http://localhost/api/streams", {
        headers: { "X-API-Key": "key-a" },
      });
      const req2 = new Request("http://localhost/api/streams", {
        headers: { "X-API-Key": "key-b" },
      });

      const result1 = await streamsRateLimit(req1, "GET", "/api/streams");
      const result2 = await streamsRateLimit(req2, "GET", "/api/streams");

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
  });
});

describe("applyRateLimit", () => {
  afterEach(() => {
    resetRateLimitStore();
  });

  it("returns null when request is within rate limit", async () => {
    const req = new Request("http://localhost/api/activity");
    const response = await applyRateLimit(req, "activity", "GET");

    expect(response).toBeNull();
  });

  it("returns 429 response when request exceeds rate limit", async () => {
    setRateLimitStore({
      check: async () => ({
        allowed: false,
        remaining: 0,
        resetAt: 1234567890,
        retryAfter: 45,
      }),
    });

    const req = new Request("http://localhost/api/activity");
    const response = await applyRateLimit(req, "activity", "GET");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
  });
});

describe("walletAuthRateLimit", () => {
  afterEach(() => {
    resetRateLimitStore();
  });

  it("allows challenge GET request when under IP limit", async () => {
    const req = new NextRequest("http://localhost/api/auth/wallet?address=GCLH2SNM5MTV4TGNNOADLYOZJYIFBXTIDVSNW4XP3LEI2UQV2MZ46OD7", {
      headers: { "x-forwarded-for": "198.51.100.1" },
    });
    const result = await walletAuthRateLimit(req, "challenge");

    expect(result.allowed).toBe(true);
  });

  it("rejects login POST request when exceeding IP rate limit", async () => {
    setRateLimitStore({
      check: async () => ({
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + 60_000,
        retryAfter: 30,
      }),
    });

    const req = new NextRequest("http://localhost/api/auth/wallet", {
      method: "POST",
      headers: {
        "x-forwarded-for": "198.51.100.2",
        "x-request-id": "req-test-wallet-limit",
      },
    });

    const result = await walletAuthRateLimit(req, "login");

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("Retry-After")).toBe("30");
      expect(result.response.headers.get("x-request-id")).toBe("req-test-wallet-limit");
      const body = await result.response.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
      expect(body.error.request_id).toBe("req-test-wallet-limit");
    }
  });
});
