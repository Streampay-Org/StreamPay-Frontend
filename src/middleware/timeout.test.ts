/**
 * src/middleware/timeout.test.ts
 *
 * Unit tests for the `withTimeout` route middleware.
 *
 * Covers:
 * • Work that completes within the deadline passes through unchanged.
 * • Work that exceeds the deadline returns 504 with the standard envelope.
 * • The `AbortSignal` is fired when the deadline passes (cooperative cancel).
 * • Non-timeout errors are re-thrown unchanged (route's catch block handles them).
 * • The 504 body contains the correct error code and a request_id.
 * • Structured `warn` log is emitted on timeout.
 * • Timeout is configurable — the deadline is respected regardless of value.
 */

import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { withTimeout } from "./timeout";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("@/app/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getCorrelationContext: jest.fn().mockReturnValue({
    request_id: "test-req-id",
    correlation_id: "test-corr-id",
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(method = "GET", url = "http://localhost/api/auth/wallet") {
  return new NextRequest(url, { method });
}

function makeOkResponse(): NextResponse {
  return NextResponse.json({ ok: true }, { status: 200 });
}

/** Sleep that honours an AbortSignal — resolves early on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  describe("happy path — work completes within deadline", () => {
    it("returns the work result unchanged", async () => {
      const expected = NextResponse.json({ token: "abc" }, { status: 200 });
      const result = await withTimeout(1_000, makeRequest(), async () => expected);
      expect(result).toBe(expected);
    });

    it("passes status code through", async () => {
      const result = await withTimeout(1_000, makeRequest(), async () =>
        NextResponse.json({}, { status: 201 }),
      );
      expect(result.status).toBe(201);
    });
  });

  describe("timeout path — deadline exceeded", () => {
    it("returns 504 when work takes longer than the deadline", async () => {
      const result = await withTimeout(
        30,
        makeRequest(),
        async (signal) => {
          // Wait until the signal fires (cooperative abort)
          await sleep(500, signal);
          return makeOkResponse();
        },
      );
      expect(result.status).toBe(504);
    });

    it("504 body has GATEWAY_TIMEOUT code", async () => {
      const result = await withTimeout(30, makeRequest(), async (signal) => {
        await sleep(500, signal);
        return makeOkResponse();
      });
      const body = await result.json();
      expect(body.error.code).toBe("GATEWAY_TIMEOUT");
    });

    it("504 body contains a request_id", async () => {
      const result = await withTimeout(30, makeRequest(), async (signal) => {
        await sleep(500, signal);
        return makeOkResponse();
      });
      const body = await result.json();
      expect(body.error.request_id).toBeDefined();
      expect(typeof body.error.request_id).toBe("string");
    });

    it("504 body has a human-readable message mentioning the deadline", async () => {
      const result = await withTimeout(
        75,
        makeRequest(),
        async (signal) => {
          await sleep(500, signal);
          return makeOkResponse();
        },
      );
      const body = await result.json();
      expect(body.error.message).toMatch(/75ms/);
    });

    it("fires the AbortSignal when the deadline passes", async () => {
      let signalAborted = false;
      await withTimeout(30, makeRequest(), async (signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            signalAborted = true;
            resolve();
          });
        });
        return makeOkResponse();
      });
      expect(signalAborted).toBe(true);
    });

    it("emits a structured warn log on timeout", async () => {
      const { logger } = jest.requireMock("@/app/lib/logger");
      await withTimeout(30, makeRequest("GET"), async (signal) => {
        await sleep(500, signal);
        return makeOkResponse();
      });
      expect(logger.warn).toHaveBeenCalledWith(
        "Request timed out",
        expect.objectContaining({
          method: "GET",
          timeoutMs: 30,
        }),
      );
    });
  });

  describe("error propagation — non-timeout errors bubble up", () => {
    it("re-throws errors from the work callback", async () => {
      await expect(
        withTimeout(1_000, makeRequest(), async () => {
          throw new Error("work blew up");
        }),
      ).rejects.toThrow("work blew up");
    });

    it("does not map arbitrary errors to 504", async () => {
      let caught: Error | undefined;
      try {
        await withTimeout(1_000, makeRequest(), async () => {
          throw new TypeError("wrong type");
        });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeInstanceOf(TypeError);
    });
  });

  describe("POST request context", () => {
    it("logs the correct method on POST timeout", async () => {
      const { logger } = jest.requireMock("@/app/lib/logger");
      jest.clearAllMocks();

      await withTimeout(
        30,
        makeRequest("POST"),
        async (signal) => {
          await sleep(500, signal);
          return makeOkResponse();
        },
      );

      expect(logger.warn).toHaveBeenCalledWith(
        "Request timed out",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("configurable deadline", () => {
    it("respects a very short deadline (10ms)", async () => {
      const start = Date.now();
      const result = await withTimeout(10, makeRequest(), async (signal) => {
        await sleep(500, signal);
        return makeOkResponse();
      });
      const elapsed = Date.now() - start;
      // Should have returned well within 500ms
      expect(elapsed).toBeLessThan(400);
      expect(result.status).toBe(504);
    });
  });
});
