/** @jest-environment node */

import { GET, POST } from "./route";
import { resetDb, getStore } from "@/app/lib/db";
import { runWithTimeout, TimeoutError } from "@/app/lib/with-timeout";

jest.mock("@/app/lib/with-timeout", () => {
  const actual = jest.requireActual("@/app/lib/with-timeout");
  return {
    ...actual,
    runWithTimeout: jest.fn(actual.runWithTimeout),
  };
});

import { resetRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { logAccessEvent } from "@/src/middleware/accessLog";
import type { Stream } from "@/app/types/openapi";

jest.mock("@/src/middleware/accessLog", () => ({
  logAccessEvent: jest.fn(),
}));

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function getRequest(query = "") {
  return new Request(`http://localhost/api/streams${query}`);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedStream(count = 3) {
  const store = getStore();
  for (let i = 0; i < count; i++) {
    const id = `stream-seed-${i}`;
    const now = new Date().toISOString();
    const stream: Stream = {
      id,
      recipient: VALID_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      token: "XLM",
    };
    store.streamRepository.streams.set(id, stream);
  }
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
  (logAccessEvent as jest.Mock).mockClear();
});

afterEach(() => {
  resetRateLimitStore();
});

describe("GET /api/streams", () => {
  describe("timeout", () => {
    it("returns 504 when handler exceeds timeout", async () => {
      (runWithTimeout as jest.Mock).mockRejectedValueOnce(new TimeoutError());
      const res = await GET(getRequest());
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.error.code).toBe("GATEWAY_TIMEOUT");
    });
  });

  describe("rate limiting", () => {
    it("returns 200 when under rate limit", async () => {
      const res = await GET(getRequest());
      expect(res.status).toBe(200);
    });

    it("returns 429 when rate limit is exceeded", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 60,
        }),
      });

      const res = await GET(getRequest());
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
    });

    it("includes Retry-After header on 429", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 30,
        }),
      });

      const res = await GET(getRequest());
      expect(res.headers.get("Retry-After")).toBe("30");
    });

    it("includes request_id in 429 error envelope", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 60,
        }),
      });

      const res = await GET(getRequest());
      const body = await res.json();
      expect(body.error.request_id).toBeDefined();
      expect(typeof body.error.request_id).toBe("string");
    });
  });

  describe("query validation", () => {
    it("returns streams list with defaults", async () => {
      seedStream(3);
      const res = await GET(getRequest());
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(3);
      expect(body.links.self).toContain("/api/v1/streams");
      expect(body.meta.total).toBe(3);
      expect(body.meta.hasNext).toBe(false);
    });

    it("respects limit parameter", async () => {
      seedStream(5);
      const res = await GET(getRequest("?limit=2"));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.meta.hasNext).toBe(true);
      expect(body.meta.nextCursor).toBeDefined();
    });

    it("returns 422 for invalid limit", async () => {
      const res = await GET(getRequest("?limit=abc"));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("filters by status", async () => {
      seedStream(3);
      const res = await GET(getRequest("?status=draft"));
      expect(res.status).toBe(200);

      const body = await res.json();
      for (const stream of body.data) {
        expect(stream.status).toBe("draft");
      }
    });

    it("returns 422 for invalid status", async () => {
      const res = await GET(getRequest("?status=bogus"));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 for malformed cursor", async () => {
      const res = await GET(getRequest("?cursor=not-base64"));
      expect(res.status).toBe(422);
    });

    it("handles empty stream list", async () => {
      const res = await GET(getRequest());
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });
  });

  describe("ETag / caching", () => {
    it("returns ETag and cache-control headers", async () => {
      const res = await GET(getRequest());
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toMatch(/^"[^"]+"$/);
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    });

    it("returns 304 when If-None-Match matches", async () => {
      const initialRes = await GET(getRequest());
      const etag = initialRes.headers.get("etag")!;

      const secondReq = new Request("http://localhost/api/streams", {
        headers: { "if-none-match": etag },
      });
      const secondRes = await GET(secondReq);
      expect(secondRes.status).toBe(304);
    });

    it("returns 200 when If-None-Match does not match", async () => {
      const res = await GET(
        new Request("http://localhost/api/streams", {
          headers: { "if-none-match": '"different-etag"' },
        }),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("error envelope", () => {
    it("includes request_id in validation errors", async () => {
      const res = await GET(
        new Request("http://localhost/api/streams?limit=abc", {
          headers: { "x-request-id": "test-req-456" },
        }),
      );
      const body = await res.json();
      expect(body.error.request_id).toBe("test-req-456");
    });
  });

  describe("structured access logs", () => {
    it("logs a 200 access event with method, path, status and duration on success", async () => {
      seedStream(2);
      const res = await GET(getRequest());
      expect(res.status).toBe(200);

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/api/streams",
          status: 200,
          durationMs: expect.any(Number),
        }),
      );
    });

    it("logs a 429 access event with an error code when rate limited", async () => {
      setRateLimitStore({
        check: async () => ({ allowed: false, remaining: 0, resetAt: 123456, retryAfter: 60 }),
      });

      await GET(getRequest());

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/api/streams",
          status: 429,
          errorCode: "rate_limit_exceeded",
        }),
      );
    });

    it("logs a 422 access event for invalid query params", async () => {
      await GET(getRequest("?limit=abc"));

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET", status: 422, errorCode: "VALIDATION_ERROR" }),
      );
    });

    it("logs a 304 access event on a matching If-None-Match", async () => {
      const initialRes = await GET(getRequest());
      const etag = initialRes.headers.get("etag")!;
      (logAccessEvent as jest.Mock).mockClear();

      await GET(new Request("http://localhost/api/streams", { headers: { "if-none-match": etag } }));

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({ method: "GET", status: 304 }),
      );
    });
  });
});

describe("POST /api/streams", () => {
  describe("timeout", () => {
    it("returns 504 when handler exceeds timeout", async () => {
      (runWithTimeout as jest.Mock).mockRejectedValueOnce(new TimeoutError());
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }));
      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body.error.code).toBe("GATEWAY_TIMEOUT");
    });
  });

  describe("rate limiting", () => {
    it("returns 201 when under rate limit", async () => {
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }));
      expect(res.status).toBe(201);
    });

    it("returns 429 when rate limit is exceeded", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 60,
        }),
      });

      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }));
      expect(res.status).toBe(429);

      const body = await res.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
    });

    it("includes Retry-After header on 429 for POST", async () => {
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 45,
        }),
      });

      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }));
      expect(res.headers.get("Retry-After")).toBe("45");
    });
  });

  describe("successful creation", () => {
    it("creates a stream with default token XLM", async () => {
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.id).toMatch(/^stream-/);
      expect(body.data.status).toBe("draft");
      expect(body.data.recipient).toBe(VALID_RECIPIENT);
      expect(body.data.rate).toBe("100");
      expect(body.data.schedule).toBe("month");
      expect(body.data.token).toBe("XLM");
      expect(body.data.createdAt).toBeDefined();
      expect(body.data.updatedAt).toBeDefined();
      expect(body.links.self).toContain(body.data.id);
    });

    it("accepts explicit token", async () => {
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "week", token: "XLM" }));
      expect(res.status).toBe(201);

      const body = await res.json();
      expect(body.data.token).toBe("XLM");
    });
  });

  describe("input validation", () => {
    it("returns 400 for non-JSON body", async () => {
      const req = new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("returns 422 for missing required fields", async () => {
      const res = await POST(postRequest({}));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toBeDefined();
      expect(body.error.details.length).toBeGreaterThan(0);
    });

    it("returns 422 for invalid token format", async () => {
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month", token: "NOT_VALID" }));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });

    it("returns 422 for token not in allowlist", async () => {
      _resetAllowlistForTesting();
      addAllowedToken("USDC");

      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month", token: "XLM" }));
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_NOT_ALLOWED");
    });
  });

  describe("idempotency", () => {
    function makeIdempotentPost(body: unknown, key: string) {
      return new Request("http://localhost/api/streams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
    }

    it("returns cached 201 for same key and body", async () => {
      const key = "test-idemp-key-1";
      const body = { recipient: VALID_RECIPIENT, rate: "50", schedule: "month" };

      const res1 = await POST(makeIdempotentPost(body, key));
      expect(res1.status).toBe(201);
      const data1 = await res1.json();

      const res2 = await POST(makeIdempotentPost(body, key));
      expect(res2.status).toBe(201);
      const data2 = await res2.json();

      expect(data2).toEqual(data1);
    });

    it("returns 409 for same key different body", async () => {
      const key = "test-idemp-key-2";

      const res1 = await POST(makeIdempotentPost({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }, key));
      expect(res1.status).toBe(201);

      const res2 = await POST(makeIdempotentPost({ recipient: VALID_RECIPIENT, rate: "100", schedule: "week" }, key));
      expect(res2.status).toBe(409);

      const body = await res2.json();
      expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("structured access logs", () => {
    it("logs a 201 access event on successful creation", async () => {
      const res = await POST(postRequest({ recipient: VALID_RECIPIENT, rate: "50", schedule: "month" }));
      expect(res.status).toBe(201);

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/api/streams",
          status: 201,
          durationMs: expect.any(Number),
        }),
      );
    });

    it("logs a 400 access event for a non-JSON body", async () => {
      const req = new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      await POST(req);

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({ method: "POST", status: 400, errorCode: "INVALID_REQUEST" }),
      );
    });

    it("logs a 422 access event for validation failures", async () => {
      await POST(postRequest({}));

      expect(logAccessEvent).toHaveBeenCalledWith(
        expect.objectContaining({ method: "POST", status: 422, errorCode: "VALIDATION_ERROR" }),
      );
    });
  });
});
