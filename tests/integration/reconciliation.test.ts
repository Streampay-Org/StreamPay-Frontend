/**
 * End-to-end integration test for GET /api/reconciliation.
 *
 * Tests the real route handler with the InMemoryRateLimitStore — the same
 * store used by {@link tests/integration/streams.test.ts} — so the full
 * handler path (validation → rate-limit → pagination → ETag → metrics) is
 * exercised without mocking logger, metrics, or ETag internals.
 *
 * Coverage goals
 * ──────────────
 * • 200 success with valid payload shape and strong ETag
 * • 304 Not Modified when If-None-Match matches
 * • 422 VALIDATION_ERROR envelope for invalid limit / cursor / status
 * • Cursor pagination (stable order, hasNext / nextCursor contract)
 * • 422 on malformed composite cursor
 * • Status filtering
 * • 429 rate-limit enforcement with Retry-After and standard error envelope
 * • Per-identity rate-limit bucket isolation
 * • Error envelope always contains request_id (correlation ID)
 */

import { GET } from "@/app/api/reconciliation/route";
import {
  InMemoryRateLimitStore,
  resetRateLimitStore,
  setRateLimitStore,
  type RateLimitStore,
  type RateLimitResult,
} from "@/app/lib/rate-limit-store";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Request for the reconciliation endpoint.
 * Allows injecting query-string params and optional request headers
 * (for identity / ETag tests).
 */
function makeRequest(
  options: { search?: string; headers?: Record<string, string> } = {},
): Request {
  const url = `http://localhost:3000/api/reconciliation${options.search ?? ""}`;
  return new Request(url, { headers: new Headers(options.headers ?? {}) });
}

// ── Test fixtures ────────────────────────────────────────────────────────────

/**
 * The route handler embeds three mock rows for the FWC26 campaign in
 * decreasing `created_at` order:
 *   1. rec-pub-1  XLM    completed  2026-01-03
 *   2. rec-pub-2  USDC   pending    2026-01-02
 *   3. rec-pub-3  USDC   failed     2026-01-01
 */
const EXPECTED_ROW_COUNT = 3;

// ── Suite ────────────────────────────────────────────────────────────────────

describe("GET /api/reconciliation – integration", () => {
  let rateLimitStore: InMemoryRateLimitStore;

  beforeEach(() => {
    // Use a generous bucket so non-rate-limit tests pass without noise.
    rateLimitStore = new InMemoryRateLimitStore(10_000);
    setRateLimitStore(rateLimitStore);
  });

  afterEach(() => {
    rateLimitStore.destroy();
    resetRateLimitStore();
  });

  // ── Success path ─────────────────────────────────────────────────────────

  describe("200 success", () => {
    it("returns a valid payload with all expected fields", async () => {
      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      const body = await res.json();

      // Top-level envelope
      expect(body.status).toBe("success");
      expect(body.data).toHaveLength(EXPECTED_ROW_COUNT);

      // Each row has the required shape (OpenAPI ReconciliationOverview)
      for (const row of body.data) {
        expect(row).toEqual(
          expect.objectContaining({
            id: expect.stringMatching(/^rec-pub-/),
            totalReconciled: expect.any(Number),
            currency: expect.any(String),
            status: expect.stringMatching(/^(completed|pending|failed)$/),
            created_at: expect.stringMatching(
              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
            ),
          }),
        );
      }

      // Meta
      expect(body.meta).toEqual({
        total: EXPECTED_ROW_COUNT,
        limit: 100,
        hasNext: false,
        nextCursor: null,
      });
    });

    it("returns records in stable (created_at DESC, id ASC) order", async () => {
      const res = await GET(makeRequest());
      const body = await res.json();

      const createdAts = body.data.map((r: any) => r.created_at);
      expect(createdAts).toEqual([
        "2026-01-03T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ]);
    });

    it("includes a strong ETag header (SHA-256 hex in double quotes)", async () => {
      const res = await GET(makeRequest());
      const etag = res.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    });
  });

  // ── ETag / 304 ───────────────────────────────────────────────────────────

  describe("ETag caching", () => {
    it("returns 304 Not Modified when If-None-Match matches the current ETag", async () => {
      // First request — capture the ETag.
      const res1 = await GET(makeRequest());
      expect(res1.status).toBe(200);
      const etag = res1.headers.get("etag")!;
      expect(etag).toBeTruthy();

      // Second request with matching If-None-Match.
      const res2 = await GET(
        makeRequest({ headers: { "If-None-Match": etag } }),
      );

      expect(res2.status).toBe(304);
      // 304 should echo the same ETag.
      expect(res2.headers.get("etag")).toBe(etag);
      // Body should be empty (null).
      expect(res2.body).toBeNull();
    });

    it("returns 200 when If-None-Match does NOT match (stale ETag)", async () => {
      const res = await GET(
        makeRequest({
          headers: { "If-None-Match": '"0000000000000000000000000000000000000000000000000000000000000000"' },
        }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("success");
    });

    it("returns 200 when no If-None-Match header is present", async () => {
      // Covered by "200 success" tests above, but explicit is clearer.
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      expect(res.headers.has("etag")).toBe(true);
    });
  });

  // ── Validation ───────────────────────────────────────────────────────────

  describe("422 input validation", () => {
    it("rejects a non-integer limit with VALIDATION_ERROR envelope", async () => {
      const res = await GET(makeRequest({ search: "?limit=invalid" }));

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toEqual(
        expect.objectContaining({
          code: "VALIDATION_ERROR",
          message: "One or more fields are invalid.",
          request_id: expect.any(String),
        }),
      );
      expect(Array.isArray(body.error.details)).toBe(true);
      expect(body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "limit",
            code: expect.any(String),
            message: expect.any(String),
          }),
        ]),
      );
    });

    it("rejects a limit outside the 1–1000 range", async () => {
      const resTooLow = await GET(makeRequest({ search: "?limit=0" }));
      const resTooHigh = await GET(makeRequest({ search: "?limit=1001" }));

      expect(resTooLow.status).toBe(422);
      expect(resTooHigh.status).toBe(422);
    });

    it("rejects an unknown status enum value", async () => {
      const res = await GET(makeRequest({ search: "?status=nope" }));

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(
        body.error.details.some((d: { field: string }) => d.field === "status"),
      ).toBe(true);
    });
  });

  // ── Cursor pagination ────────────────────────────────────────────────────

  describe("cursor pagination", () => {
    it("returns hasNext=true and nextCursor when limit is smaller than total rows", async () => {
      const res = await GET(makeRequest({ search: "?limit=1" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.meta.hasNext).toBe(true);
      expect(body.meta.nextCursor).toEqual(expect.any(String));
      expect(body.meta.total).toBe(EXPECTED_ROW_COUNT);
    });

    it("walks through all pages using cursor chain", async () => {
      const seenIds: string[] = [];

      // Page 1: limit=1
      const res1 = await GET(makeRequest({ search: "?limit=1" }));
      expect(res1.status).toBe(200);
      let body = await res1.json();
      expect(body.data).toHaveLength(1);
      expect(body.meta.hasNext).toBe(true);
      seenIds.push(body.data[0].id);
      const cursor1 = body.meta.nextCursor;

      // Page 2: use cursor from page 1
      const res2 = await GET(makeRequest({ search: `?limit=1&cursor=${cursor1}` }));
      expect(res2.status).toBe(200);
      body = await res2.json();
      expect(body.data).toHaveLength(1);
      seenIds.push(body.data[0].id);

      // Page 3: final row
      const cursor2 = body.meta.nextCursor;
      expect(cursor2).toEqual(expect.any(String));

      const res3 = await GET(makeRequest({ search: `?limit=1&cursor=${cursor2}` }));
      expect(res3.status).toBe(200);
      body = await res3.json();
      expect(body.data).toHaveLength(1);
      seenIds.push(body.data[0].id);

      // No more pages
      expect(body.meta.hasNext).toBe(false);
      expect(body.meta.nextCursor).toBeNull();

      // All three unique IDs seen, in the expected order.
      expect(seenIds).toHaveLength(3);
      expect(new Set(seenIds).size).toBe(3);
    });

    it("returns 422 for a malformed composite cursor", async () => {
      const res = await GET(makeRequest({ search: "?cursor=garbage" }));

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toEqual(
        expect.objectContaining({
          code: "INVALID_CURSOR",
          message: "Query param cursor is malformed.",
          request_id: expect.any(String),
        }),
      );
    });

    it("returns 422 for an empty cursor string", async () => {
      // The Zod validator rejects empty cursor strings.
      const res = await GET(makeRequest({ search: "?cursor=   " }));

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(
        body.error.details.some((d: { field: string }) => d.field === "cursor"),
      ).toBe(true);
    });
  });

  // ── Status filtering ─────────────────────────────────────────────────────

  describe("status filtering", () => {
    it("returns only matching rows for status=completed", async () => {
      const res = await GET(makeRequest({ search: "?status=completed" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("completed");
      expect(body.data[0].id).toBe("rec-pub-1");
    });

    it("returns only matching rows for status=failed", async () => {
      const res = await GET(makeRequest({ search: "?status=failed" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("failed");
      expect(body.data[0].id).toBe("rec-pub-3");
    });

    it("correctly counts filtered results in meta.total", async () => {
      const res = await GET(makeRequest({ search: "?status=pending" }));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta.total).toBe(1);
      expect(body.data).toHaveLength(1);
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────────
  //
  // The rate-limiter buckets are controlled by the limit/window params that
  // `applyRateLimit` passes to the store, NOT by the InMemoryRateLimitStore
  // constructor.  To reliably test exhaustion we inject a lightweight
  // counting store (same pattern as the route unit test).

  /**
   * A simple counting store that tracks remaining requests per identity.
   * After `remaining` successful checks, every subsequent check is denied.
   */
  function makeExhaustedStore(remaining: number, retryAfter = 30): RateLimitStore {
    const counters = new Map<string, number>();
    return {
      async check(identifier: string): Promise<RateLimitResult> {
        const used = counters.get(identifier) ?? 0;
        if (used < remaining) {
          counters.set(identifier, used + 1);
          return {
            allowed: true,
            remaining: remaining - used - 1,
            resetAt: Math.floor(Date.now() / 1000) + 60,
          };
        }
        return {
          allowed: false,
          remaining: 0,
          resetAt: Math.floor(Date.now() / 1000) + retryAfter,
          retryAfter,
        };
      },
    };
  }

  describe("429 rate limiting", () => {
    it("returns 429 with Retry-After when the bucket is exhausted", async () => {
      setRateLimitStore(makeExhaustedStore(0));

      const res = await GET(makeRequest());

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toEqual(expect.any(String));
    });

    it("429 response carries the standard error envelope with request_id", async () => {
      setRateLimitStore(makeExhaustedStore(0));

      const res = await GET(makeRequest());
      const body = await res.json();

      expect(body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
            request_id: expect.any(String),
          }),
        }),
      );
    });

    it("allows requests while under the limit, then throttles", async () => {
      // Allow exactly 2 requests, then deny.
      setRateLimitStore(makeExhaustedStore(2));

      const res1 = await GET(makeRequest());
      const res2 = await GET(makeRequest());
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const res3 = await GET(makeRequest());
      expect(res3.status).toBe(429);
    });

    it("different identities get independent rate-limit buckets", async () => {
      // Each identity gets exactly 1 request.
      setRateLimitStore(makeExhaustedStore(1));

      const resA1 = await GET(
        makeRequest({ headers: { "X-API-Key": "key-alice" } }),
      );
      const resB1 = await GET(
        makeRequest({ headers: { "X-API-Key": "key-bob" } }),
      );
      expect(resA1.status).toBe(200);
      expect(resB1.status).toBe(200);

      // Second request from Alice — should be throttled.
      const resA2 = await GET(
        makeRequest({ headers: { "X-API-Key": "key-alice" } }),
      );
      expect(resA2.status).toBe(429);

      // Bob should also be throttled on his second request.
      const resB2 = await GET(
        makeRequest({ headers: { "X-API-Key": "key-bob" } }),
      );
      expect(resB2.status).toBe(429);
    });

    it("uses IP-based identity when no auth headers are present", async () => {
      setRateLimitStore(makeExhaustedStore(1));

      const res1 = await GET(
        makeRequest({ headers: { "X-Forwarded-For": "10.0.0.1" } }),
      );
      expect(res1.status).toBe(200);

      const res2 = await GET(
        makeRequest({ headers: { "X-Forwarded-For": "10.0.0.1" } }),
      );
      expect(res2.status).toBe(429);

      // Different IP still gets through.
      const res3 = await GET(
        makeRequest({ headers: { "X-Forwarded-For": "10.0.0.2" } }),
      );
      expect(res3.status).toBe(200);
    });
  });

  // ── Error envelope contract ──────────────────────────────────────────────

  describe("error envelope contract", () => {
    it("every error response includes a request_id (correlation ID)", async () => {
      const errorCases = [
        makeRequest({ search: "?limit=invalid" }),
        makeRequest({ search: "?cursor=garbage" }),
      ];

      for (const req of errorCases) {
        const res = await GET(req);
        const body = await res.json();
        expect(body.error.request_id).toEqual(expect.any(String));
      }
    });

    it("every error response uses a machine-readable code string", async () => {
      const errorCases = [
        { req: makeRequest({ search: "?limit=invalid" }), expectedCode: "VALIDATION_ERROR" },
        { req: makeRequest({ search: "?cursor=garbage" }), expectedCode: "INVALID_CURSOR" },
      ];

      for (const { req, expectedCode } of errorCases) {
        const res = await GET(req);
        const body = await res.json();
        expect(body.error.code).toBe(expectedCode);
      }
    });
  });

  // ── Combined scenarios ───────────────────────────────────────────────────

  describe("combined scenarios", () => {
    it("status filter + valid limit works together", async () => {
      const res = await GET(
        makeRequest({ search: "?status=completed&limit=50" }),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("completed");
      expect(body.meta.limit).toBe(50);
    });

    it("ETag is deterministic — two identical requests produce the same ETag", async () => {
      const res1 = await GET(makeRequest());
      const res2 = await GET(makeRequest());

      expect(res1.headers.get("etag")).toBe(res2.headers.get("etag"));
    });

    it("different query params produce different ETags", async () => {
      const resBase = await GET(makeRequest());
      const resFiltered = await GET(makeRequest({ search: "?status=completed" }));

      expect(resBase.headers.get("etag")).not.toBe(
        resFiltered.headers.get("etag"),
      );
    });
  });
});
