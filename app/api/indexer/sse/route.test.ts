/**
 * @jest-environment node
 *
 * Tests for GET /api/indexer/sse
 *
 * SSE streams are tested by:
 *  1. Setting SSE_INTERVAL_MS=0 so setTimeout resolves immediately.
 *  2. Setting SSE_MAX_EVENTS to a small number so the loop terminates fast.
 *  3. Reading the raw response body and splitting on the SSE frame separator
 *     ("\n\n") to inspect individual events.
 */

// ── Env config for fast tests (must be set before module import) ─────────────
process.env.SSE_INTERVAL_MS = "0";
process.env.SSE_MAX_EVENTS = "3"; // initial + 2 loop iterations → 3 events total

import { GET, getIndexerStatus } from "./route";
import { _resetAdminStateForTesting, setCircuitBreaker } from "@/app/lib/admin-guard";

// ── Mock logger so tests stay silent and we can assert log calls ─────────────
jest.mock("@/app/lib/logger", () => ({
  extractCorrelationContext: jest.fn((headers: Headers) => ({
    request_id: headers.get("x-request-id") ?? "test-req-id",
    correlation_id: headers.get("x-correlation-id") ?? "test-corr-id",
  })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  withCorrelationContext: jest.fn(
    (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal GET request for the SSE endpoint. */
function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/indexer/sse", { headers });
}

/**
 * Drain the SSE response body to a string and split into individual event
 * frames.  Each frame ends with the double-newline SSE separator.
 */
async function drainFrames(response: Response): Promise<string[]> {
  const text = await response.text();
  // Split on blank lines between frames; filter empty strings from trailing \n\n
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Parse a single SSE frame into its `event` name and parsed `data` object.
 * Expects the frame to contain exactly `event: …` and `data: …` lines.
 */
function parseFrame(frame: string): { event: string; data: Record<string, unknown> } {
  const lines = frame.split("\n").map((l) => l.trim());
  const eventLine = lines.find((l) => l.startsWith("event:")) ?? "";
  const dataLine = lines.find((l) => l.startsWith("data:")) ?? "";
  return {
    event: eventLine.replace(/^event:\s*/, ""),
    data: JSON.parse(dataLine.replace(/^data:\s*/, "")),
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  _resetAdminStateForTesting();
  jest.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/indexer/sse", () => {
  // ── Response structure ───────────────────────────────────────────────────

  describe("response headers", () => {
    it("returns 200 with correct SSE headers", async () => {
      const res = await GET(makeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/event-stream");
      expect(res.headers.get("Cache-Control")).toBe("no-cache, no-transform");
      expect(res.headers.get("Connection")).toBe("keep-alive");
      expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    });

    it("echoes correlation request_id in X-Request-Id header", async () => {
      const res = await GET(
        makeRequest({ "x-request-id": "my-trace-id" }),
      );

      expect(res.headers.get("X-Request-Id")).toBe("my-trace-id");
    });

    it("falls back to a generated request_id when no header is supplied", async () => {
      const res = await GET(makeRequest());

      // The mock returns "test-req-id" when no x-request-id header is present.
      expect(res.headers.get("X-Request-Id")).toBe("test-req-id");
    });
  });

  // ── SSE stream content ───────────────────────────────────────────────────

  describe("stream content", () => {
    it("emits only 'indexer_status' events", async () => {
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      expect(frames.length).toBeGreaterThanOrEqual(1);
      for (const frame of frames) {
        const { event } = parseFrame(frame);
        expect(event).toBe("indexer_status");
      }
    });

    it("emits the initial snapshot immediately (first frame)", async () => {
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);
      const { event, data } = parseFrame(frames[0]);

      expect(event).toBe("indexer_status");
      expect(typeof data.ledgerCursor).toBe("number");
      expect(typeof data.lagMs).toBe("number");
      expect(typeof data.queueDepth).toBe("number");
      expect(typeof data.syncedAt).toBe("string");
      expect(new Date(data.syncedAt as string).toString()).not.toBe("Invalid Date");
      expect(typeof data.breakerOpen).toBe("boolean");
    });

    it("emits exactly SSE_MAX_EVENTS frames when breaker is closed", async () => {
      // SSE_MAX_EVENTS=3 set at top of file
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      expect(frames).toHaveLength(3);
    });

    it("all frames carry valid IndexerStatus payloads", async () => {
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      for (const frame of frames) {
        const { data } = parseFrame(frame);
        expect(data).toMatchObject({
          ledgerCursor: expect.any(Number),
          lagMs: expect.any(Number),
          queueDepth: expect.any(Number),
          syncedAt: expect.any(String),
          breakerOpen: expect.any(Boolean),
        });
      }
    });

    it("each frame is a valid SSE wire-format string", async () => {
      const res = await GET(makeRequest());
      const text = await res.text();

      // Every frame must start with "event:" and contain "data:"
      const frames = text.split("\n\n").filter(Boolean);
      for (const frame of frames) {
        expect(frame).toMatch(/^event:/m);
        expect(frame).toMatch(/^data:/m);
      }
    });
  });

  // ── Circuit breaker ──────────────────────────────────────────────────────

  describe("circuit breaker", () => {
    /** Open the indexer circuit breaker using a fake admin request. */
    function openBreaker() {
      _resetAdminStateForTesting("GADMIN");
      const fakeAdminReq = new Request("http://localhost/test", {
        headers: { "Actor-Wallet-Address": "GADMIN" },
      });
      setCircuitBreaker(fakeAdminReq, "indexer", true);
    }

    it("breakerOpen is false in all frames when breaker is closed", async () => {
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      for (const frame of frames) {
        const { data } = parseFrame(frame);
        expect(data.breakerOpen).toBe(false);
      }
    });

    it("emits a single frame with breakerOpen:true and closes when breaker is open on connect", async () => {
      openBreaker();

      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      // Only the initial snapshot should be emitted, then the stream closes.
      expect(frames).toHaveLength(1);
      const { data } = parseFrame(frames[0]);
      expect(data.breakerOpen).toBe(true);
    });

    it("logs a warning when the circuit breaker is open on connect", async () => {
      openBreaker();
      const { logger } = jest.requireMock<typeof import("@/app/lib/logger")>(
        "@/app/lib/logger",
      );

      await GET(makeRequest());

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("circuit breaker open on connect"),
        expect.any(Object),
      );
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("returns 429 once the read bucket is exhausted", async () => {
      // Use a distinct IP so this test doesn't share quota with others.
      const headers = { "x-forwarded-for": "sse-rate-limit-test" };
      let limited = false;
      let retryAfter: string | null = null;

      for (let i = 0; i < 70; i++) {
        const res = await GET(makeRequest(headers));
        if (res.status === 429) {
          limited = true;
          retryAfter = res.headers.get("Retry-After");
          break;
        }
      }

      expect(limited).toBe(true);
      expect(retryAfter).not.toBeNull();
    });

    it("429 body contains a structured error envelope", async () => {
      const headers = { "x-forwarded-for": "sse-rate-limit-envelope-test" };
      let body: Record<string, unknown> | null = null;

      for (let i = 0; i < 70; i++) {
        const res = await GET(makeRequest(headers));
        if (res.status === 429) {
          body = await res.json();
          break;
        }
      }

      expect(body).not.toBeNull();
      expect(body!.error).toMatchObject({
        code: "rate_limit_exceeded",
        message: expect.any(String),
      });
    });
  });

  // ── Correlation context ──────────────────────────────────────────────────

  describe("correlation context", () => {
    it("passes correlation headers through to the context", async () => {
      const { extractCorrelationContext } =
        jest.requireMock<typeof import("@/app/lib/logger")>("@/app/lib/logger");

      await GET(
        makeRequest({
          "x-correlation-id": "corr-abc",
          "x-request-id": "req-xyz",
        }),
      );

      expect(extractCorrelationContext).toHaveBeenCalledWith(
        expect.objectContaining({
          get: expect.any(Function),
        }),
      );
    });

    it("logs stream opened with identity metadata", async () => {
      const { logger } =
        jest.requireMock<typeof import("@/app/lib/logger")>("@/app/lib/logger");

      await GET(makeRequest({ "x-forwarded-for": "1.2.3.4" }));

      expect(logger.info).toHaveBeenCalledWith(
        "SSE indexer stream opened",
        expect.objectContaining({ identity_type: expect.any(String) }),
      );
    });

    it("logs stream closed after normal completion", async () => {
      const { logger } =
        jest.requireMock<typeof import("@/app/lib/logger")>("@/app/lib/logger");

      await GET(makeRequest());

      expect(logger.info).toHaveBeenCalledWith(
        "SSE indexer stream closed",
        expect.objectContaining({ events_emitted: expect.any(Number) }),
      );
    });
  });

  // ── getIndexerStatus unit ────────────────────────────────────────────────

  describe("getIndexerStatus()", () => {
    it("returns a snapshot with all required fields", () => {
      const status = getIndexerStatus();

      expect(status).toMatchObject({
        ledgerCursor: expect.any(Number),
        lagMs: expect.any(Number),
        queueDepth: expect.any(Number),
        syncedAt: expect.any(String),
        breakerOpen: expect.any(Boolean),
      });
    });

    it("ledgerCursor is in the expected range", () => {
      const status = getIndexerStatus();
      expect(status.ledgerCursor).toBeGreaterThanOrEqual(50_000_000);
      expect(status.ledgerCursor).toBeLessThan(50_001_000);
    });

    it("lagMs is non-negative", () => {
      const status = getIndexerStatus();
      expect(status.lagMs).toBeGreaterThanOrEqual(0);
    });

    it("syncedAt is a valid ISO-8601 timestamp", () => {
      const status = getIndexerStatus();
      expect(new Date(status.syncedAt).toString()).not.toBe("Invalid Date");
    });

    it("reflects the circuit breaker state", () => {
      _resetAdminStateForTesting("GADMIN");
      const fakeAdminReq = new Request("http://localhost/test", {
        headers: { "Actor-Wallet-Address": "GADMIN" },
      });

      setCircuitBreaker(fakeAdminReq, "indexer", true);
      expect(getIndexerStatus().breakerOpen).toBe(true);

      setCircuitBreaker(fakeAdminReq, "indexer", false);
      expect(getIndexerStatus().breakerOpen).toBe(false);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles a missing x-forwarded-for header gracefully", async () => {
      const res = await GET(makeRequest()); // no IP header
      expect(res.status).toBe(200);
    });

    it("handles concurrent requests independently", async () => {
      const results = await Promise.all([
        GET(makeRequest({ "x-forwarded-for": "concurrent-1" })),
        GET(makeRequest({ "x-forwarded-for": "concurrent-2" })),
        GET(makeRequest({ "x-forwarded-for": "concurrent-3" })),
      ]);

      for (const res of results) {
        expect(res.status).toBe(200);
        const frames = await drainFrames(res);
        expect(frames.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("data JSON is valid in every frame even when syncedAt changes", async () => {
      const res = await GET(makeRequest());
      const frames = await drainFrames(res);

      for (const frame of frames) {
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:")) ?? "";
        expect(() => JSON.parse(dataLine.replace(/^data:\s*/, ""))).not.toThrow();
      }
    });
  });
});

// -- Backpressure & queue overflow (appended) --------------------------------

describe("GET /api/indexer/sse -- backpressure & queue overflow", () => {
  beforeEach(() => {
    _resetAdminStateForTesting();
    jest.clearAllMocks();
  });

  it("returns X-SSE-Queue-Capacity header on successful SSE response", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const cap = res.headers.get("X-SSE-Queue-Capacity");
    expect(cap).not.toBeNull();
    expect(Number(cap)).toBeGreaterThan(0);
  });

  it("X-SSE-Queue-Capacity reflects SSE_QUEUE_CAPACITY env override", async () => {
    const prev = process.env.SSE_QUEUE_CAPACITY;
    process.env.SSE_QUEUE_CAPACITY = "32";
    try {
      const res = await GET(makeRequest());
      expect(res.headers.get("X-SSE-Queue-Capacity")).toBe("32");
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_CAPACITY;
      else process.env.SSE_QUEUE_CAPACITY = prev;
    }
  });

  it("logs a warning when SSE queue backpressure or overflow is detected", async () => {
    const prev = process.env.SSE_QUEUE_CAPACITY;
    process.env.SSE_QUEUE_CAPACITY = "1";
    const { logger } = jest.requireMock<typeof import("@/app/lib/logger")>(
      "@/app/lib/logger",
    );

    try {
      await GET(makeRequest());
      const warnCalls = (logger.warn as jest.Mock).mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      const hasBackpressureLog = warnCalls.some(
        (msg) =>
          msg.includes("backpressure") ||
          msg.includes("dropped") ||
          msg.includes("overflow") ||
          msg.includes("evicted"),
      );
      expect(hasBackpressureLog).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_CAPACITY;
      else process.env.SSE_QUEUE_CAPACITY = prev;
    }
  });

  it("stream completes without throwing even when queue is tiny (drop policy)", async () => {
    const prev = process.env.SSE_QUEUE_CAPACITY;
    const prevPolicy = process.env.SSE_QUEUE_POLICY;
    process.env.SSE_QUEUE_CAPACITY = "1";
    process.env.SSE_QUEUE_POLICY = "drop";

    try {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const frames = await drainFrames(res);
      expect(frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_CAPACITY;
      else process.env.SSE_QUEUE_CAPACITY = prev;
      if (prevPolicy === undefined) delete process.env.SSE_QUEUE_POLICY;
      else process.env.SSE_QUEUE_POLICY = prevPolicy;
    }
  });

  it("stream terminates cleanly with error policy on overflow", async () => {
    const prev = process.env.SSE_QUEUE_CAPACITY;
    const prevPolicy = process.env.SSE_QUEUE_POLICY;
    process.env.SSE_QUEUE_CAPACITY = "1";
    process.env.SSE_QUEUE_POLICY = "error";

    try {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const frames = await drainFrames(res);
      expect(frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_CAPACITY;
      else process.env.SSE_QUEUE_CAPACITY = prev;
      if (prevPolicy === undefined) delete process.env.SSE_QUEUE_POLICY;
      else process.env.SSE_QUEUE_POLICY = prevPolicy;
    }
  });

  it("unknown SSE_QUEUE_POLICY value defaults to drop (no throw)", async () => {
    const prev = process.env.SSE_QUEUE_POLICY;
    process.env.SSE_QUEUE_POLICY = "invalid-policy";

    try {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_POLICY;
      else process.env.SSE_QUEUE_POLICY = prev;
    }
  });

  it("all emitted frames retain valid SSE wire format under overflow conditions", async () => {
    const prev = process.env.SSE_QUEUE_CAPACITY;
    const prevPolicy = process.env.SSE_QUEUE_POLICY;
    process.env.SSE_QUEUE_CAPACITY = "1";
    process.env.SSE_QUEUE_POLICY = "drop";

    try {
      const res = await GET(makeRequest());
      const text = await res.text();
      const frames = text.split("\n\n").filter(Boolean);
      for (const frame of frames) {
        expect(frame).toMatch(/^event:/m);
        expect(frame).toMatch(/^data:/m);
      }
    } finally {
      if (prev === undefined) delete process.env.SSE_QUEUE_CAPACITY;
      else process.env.SSE_QUEUE_CAPACITY = prev;
      if (prevPolicy === undefined) delete process.env.SSE_QUEUE_POLICY;
      else process.env.SSE_QUEUE_POLICY = prevPolicy;
    }
  });
});
