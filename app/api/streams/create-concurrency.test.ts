/** @jest-environment node */

import { POST } from "./route";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import * as streamIdModule from "@/app/lib/stream-id";
import type { Stream } from "@/app/types/openapi";
import fs from "fs";
import path from "path";

jest.mock("@/app/lib/stream-id", () => {
  const actual = jest.requireActual("@/app/lib/stream-id");
  return {
    ...actual,
    newStreamId: jest.fn((...args: unknown[]) => actual.newStreamId(...args)),
  };
});

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function postRequest(body: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const actual = jest.requireActual("@/app/lib/stream-id");
  (streamIdModule.newStreamId as jest.Mock).mockImplementation((...args: unknown[]) =>
    actual.newStreamId(...args)
  );
  resetDb();
  resetRateLimitStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
  jest.restoreAllMocks();
});

afterEach(() => {
  resetRateLimitStore();
  jest.restoreAllMocks();
});

describe("POST /api/streams concurrency and collision safety", () => {
  const validBody = {
    recipient: VALID_RECIPIENT,
    rate: "100",
    schedule: "month",
    token: "XLM",
  };

  it("Scenario 1: 10 concurrent POSTs with the same key and body create exactly one stream and return identical responses", async () => {
    const store = getStore();
    const initialSize = store.streamRepository.streams.size;
    const key = "concurrent-key-1";

    const requests = Array.from({ length: 10 }, () => postRequest(validBody, key));
    const responses = await Promise.all(requests.map((req) => POST(req)));

    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const bodies = await Promise.all(responses.map((res) => res.json()));
    const firstBody = bodies[0];

    for (const body of bodies) {
      expect(body).toEqual(firstBody);
    }

    expect(store.streamRepository.streams.size).toBe(initialSize + 1);
    expect(store.streamRepository.streams.get(firstBody.data.id)).toBeDefined();
  });

  it("Scenario 2: 10 concurrent POSTs without a key create 10 distinct streams", async () => {
    const store = getStore();
    const initialSize = store.streamRepository.streams.size;

    const requests = Array.from({ length: 10 }, () => postRequest(validBody));
    const responses = await Promise.all(requests.map((req) => POST(req)));

    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const bodies = await Promise.all(responses.map((res) => res.json()));
    const ids = new Set(bodies.map((b) => b.data.id));

    expect(ids.size).toBe(10);
    expect(store.streamRepository.streams.size).toBe(initialSize + 10);
  });

  it("Scenario 3: same key, different body, concurrent returns one 201 and the rest 409", async () => {
    const key = "concurrent-conflict-key";
    const bodies = [
      { ...validBody, rate: "10" },
      { ...validBody, rate: "20" },
      { ...validBody, rate: "30" },
      { ...validBody, rate: "40" },
      { ...validBody, rate: "50" },
    ];

    const requests = bodies.map((b) => postRequest(b, key));
    const responses = await Promise.all(requests.map((req) => POST(req)));

    const statuses = responses.map((r) => r.status);
    const count201 = statuses.filter((s) => s === 201).length;
    const count409 = statuses.filter((s) => s === 409).length;

    expect(count201).toBe(1);
    expect(count409).toBe(4);

    for (const res of responses) {
      if (res.status === 409) {
        const body = await res.json();
        expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      }
    }
  });

  it("Scenario 4: forced id collision retries and gets a fresh id without overwriting existing stream", async () => {
    const store = getStore();
    const existingStream: Stream = {
      id: "stream-existing-1234567890abcdef",
      recipient: VALID_RECIPIENT,
      rate: "original-rate",
      schedule: "month",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      token: "XLM",
    };
    store.streamRepository.streams.set(existingStream.id, existingStream);

    const freshId = "stream-fresh-0987654321fedcba";
    (streamIdModule.newStreamId as jest.Mock)
      .mockReturnValueOnce(existingStream.id)
      .mockReturnValueOnce(freshId);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.data.id).toBe(freshId);

    // Ensure the existing stream was not overwritten
    const preserved = store.streamRepository.streams.get(existingStream.id);
    expect(preserved?.rate).toBe("original-rate");
    expect(preserved?.status).toBe("active");
  });

  it("Scenario 5: generator collides 3 times yields 500 with no overwrite", async () => {
    const store = getStore();
    const existingStream: Stream = {
      id: "stream-permanent-collision",
      recipient: VALID_RECIPIENT,
      rate: "untouched-rate",
      schedule: "month",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      token: "XLM",
    };
    store.streamRepository.streams.set(existingStream.id, existingStream);

    const initialSize = store.streamRepository.streams.size;
    (streamIdModule.newStreamId as jest.Mock).mockReturnValue(existingStream.id);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error.code).toBe("ID_GENERATION_FAILED");

    // Existing stream remains untouched and no new stream was inserted
    expect(store.streamRepository.streams.size).toBe(initialSize);
    expect(store.streamRepository.streams.get(existingStream.id)?.rate).toBe("untouched-rate");
  });

  it("Scenario 6: validation failure with a key, then a valid retry with the same key returns 422 then 201", async () => {
    const key = "validation-retry-key";

    // Invalid body (missing recipient and schedule)
    const invalidRes = await POST(postRequest({ rate: "100" }, key));
    expect(invalidRes.status).toBe(422);

    const invalidBody = await invalidRes.json();
    expect(invalidBody.error.code).toBe("VALIDATION_ERROR");

    // Valid retry with the same idempotency key
    const validRes = await POST(postRequest(validBody, key));
    expect(validRes.status).toBe(201);

    const validJson = await validRes.json();
    expect(validJson.data.recipient).toBe(VALID_RECIPIENT);
  });

  it("Scenario 7: id format matches ^stream-[a-z0-9]{20,}$", async () => {
    const rawId = streamIdModule.newStreamId();
    expect(rawId).toMatch(/^stream-[a-z0-9]{20,}$/);

    const res = await POST(postRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toMatch(/^stream-[a-z0-9]{20,}$/);
  });

  it("Scenario 8: all creation paths use newStreamId() without randomUUID().slice(0, 8) (grep check)", () => {
    const creationFiles = [
      "app/api/streams/route.ts",
      "app/api/v2/streams/route.ts",
      "app/api/streams/batch/route.ts",
      "app/api/streams/import/route.ts",
    ];

    for (const relPath of creationFiles) {
      const fullPath = path.resolve(process.cwd(), relPath);
      const content = fs.readFileSync(fullPath, "utf8");

      expect(content).toContain("newStreamId");
      expect(content).not.toMatch(/randomUUID\(\)\.slice\(0,\s*8\)/);
    }
  });

  describe("create handler edge cases for coverage", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const req = new Request("http://localhost/api/streams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("returns 422 when token format is invalid", async () => {
      const res = await POST(postRequest({ ...validBody, token: "NOT:A:VALID:TOKEN" }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });

    it("returns 422 when token is not in allowlist", async () => {
      _resetAllowlistForTesting();
      // Only allow a different token, e.g. a specific classic asset
      addAllowedToken("USDC:GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA");
      const res = await POST(postRequest({ ...validBody, token: "XLM" }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("TOKEN_NOT_ALLOWED");
    });

    it("returns 429 when rate limit is exceeded", async () => {
      const { setRateLimitStore } = require("@/app/lib/rate-limit-store");
      setRateLimitStore({
        check: async () => ({
          allowed: false,
          remaining: 0,
          resetAt: 123456,
          retryAfter: 60,
        }),
      });
      const res = await POST(postRequest(validBody));
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe("rate_limit_exceeded");
    });
  });
});
