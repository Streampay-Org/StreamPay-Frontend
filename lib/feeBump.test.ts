/**
 * feeBump.test.ts
 *
 * Focused unit tests for lib/feeBump.ts (GrantFox FWC26 — fee-bump support).
 *
 * Coverage targets:
 *   - resolveFeeBumpConfig: all validation branches
 *   - isFeeRelatedFailure:  all detection branches
 *   - buildFeeBumpEnvelope: envelope format
 *   - maybeFeeBump:         all code paths (skip, config error, no hash,
 *                           fetch failure, missing envelope_xdr, submit
 *                           failure, missing hash in response, success,
 *                           network error)
 *
 * Design principles:
 *   - Jest (not vitest) — uses describe/it/expect from @jest/globals.
 *   - Env vars are set per-test via process.env; originals are restored in
 *     afterEach to keep test isolation.
 *   - The logger is mocked to prevent JSON noise in test output and to let
 *     tests assert on log calls.
 *   - No real network calls; all fetch paths use the injectable `fetcher`.
 */

import {
  isFeeRelatedFailure,
  maybeFeeBump,
  resolveFeeBumpConfig,
  buildFeeBumpEnvelope,
  type FeeBumpResult,
} from "./feeBump";
import type { Stream, WithdrawalStatus } from "@/app/types/openapi";

// ── Mock the logger so tests stay quiet ──────────────────────────────────────
jest.mock("@/app/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { logger } from "@/app/lib/logger";
const mockLogger = logger as jest.Mocked<typeof logger>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid Stream that satisfies the TypeScript interface. */
function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-1",
    recipient: "GRECIPIENT000000000000000000000000000000000000000000000",
    rate: "100",
    schedule: "linear",
    status: "ended",
    token: "XLM",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settlementTxHash: "abc123",
    ...overrides,
  };
}

/** Withdrawal in the "failed due to insufficient fee" state. */
function makeFeeFailedWithdrawal(
  failureCode = "tx_insufficient_fee",
): WithdrawalStatus {
  return {
    state: "failed",
    failureCode,
    requestedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    attempts: 1,
    settlementTxHash: "abc123",
  };
}

/** Stream whose withdrawal has already failed with a fee-related error. */
function makeFeeFailedStream(failureCode = "tx_insufficient_fee"): Stream {
  return makeStream({ withdrawal: makeFeeFailedWithdrawal(failureCode) });
}

// ── resolveFeeBumpConfig ──────────────────────────────────────────────────────

describe("resolveFeeBumpConfig", () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns error when FEE_BUMP_SECRET_KEY is absent", () => {
    delete process.env.FEE_BUMP_SECRET_KEY;
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("FEE_BUMP_SECRET_KEY is not configured");
    }
  });

  it("returns error when FEE_BUMP_SECRET_KEY is empty string", () => {
    process.env.FEE_BUMP_SECRET_KEY = "";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
  });

  it("returns error when FEE_BUMP_SECRET_KEY does not start with S", () => {
    process.env.FEE_BUMP_SECRET_KEY = "GABCDEF";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("valid Stellar secret key");
    }
  });

  it("returns ok for a valid strkey starting with S", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    delete process.env.HORIZON_URL;
    delete process.env.FEE_BUMP_MAX_FEE;
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secretKey).toBe("SABCDEFG");
      expect(result.config.horizonUrl).toBe("https://horizon-testnet.stellar.org");
      expect(result.config.maxFee).toBe(100_000);
    }
  });

  it("accepts a custom valid HORIZON_URL", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("returns error for a non-URL HORIZON_URL", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.HORIZON_URL = "not-a-url";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a valid URL");
    }
  });

  it("returns error for a non-http HORIZON_URL protocol", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.HORIZON_URL = "ftp://horizon.example.com";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("http(s) protocol");
    }
  });

  it("accepts a custom valid FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "200000";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.maxFee).toBe(200_000);
    }
  });

  it("returns error for a non-integer FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "abc";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("positive integer");
    }
  });

  it("returns error for a zero FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "0";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
  });

  it("returns error for a negative FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "-100";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
  });

  it("returns error when FEE_BUMP_MAX_FEE exceeds the ceiling", () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "99999999";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ceiling");
    }
  });
});

// ── isFeeRelatedFailure ───────────────────────────────────────────────────────

describe("isFeeRelatedFailure", () => {
  it("returns true for tx_insufficient_fee", () => {
    const stream = makeFeeFailedStream("tx_insufficient_fee");
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns true for tx_too_late", () => {
    const stream = makeFeeFailedStream("tx_too_late");
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns true for INSUFFICIENT_FEE", () => {
    const stream = makeFeeFailedStream("INSUFFICIENT_FEE");
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns true when failureCode contains pattern as substring", () => {
    const stream = makeFeeFailedStream("soroban_tx_insufficient_fee_detail");
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns false for an unrelated failure code", () => {
    const stream = makeFeeFailedStream("REORG_DETECTED");
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false when state is pending (not failed)", () => {
    const stream = makeStream({
      withdrawal: {
        state: "pending",
        failureCode: "tx_insufficient_fee",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false when state is succeeded", () => {
    const stream = makeStream({
      withdrawal: {
        state: "succeeded",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false when withdrawal is absent", () => {
    const stream = makeStream({ withdrawal: undefined });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false when failureCode is absent on a failed withdrawal", () => {
    const stream = makeStream({
      withdrawal: {
        state: "failed",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });
});

// ── buildFeeBumpEnvelope ──────────────────────────────────────────────────────

describe("buildFeeBumpEnvelope", () => {
  it("produces a tagged envelope string", () => {
    const result = buildFeeBumpEnvelope("inner_xdr_123", "SABCDEF", 100_000);
    expect(result).toBe("fee_bump:100000:inner_xdr_123");
  });

  it("embeds the maxFee in the tag", () => {
    const result = buildFeeBumpEnvelope("xdr", "SABCDEF", 250_000);
    expect(result).toContain("250000");
  });

  it("does not embed the secret key in the output", () => {
    const secretKey = "SSECRETKEYTHATMUSTNOTAPPEAR";
    const result = buildFeeBumpEnvelope("xdr", secretKey, 100_000);
    expect(result).not.toContain(secretKey);
  });

  it("preserves the inner XDR verbatim", () => {
    const inner = "AAAAAQAAAA==base64content==";
    const result = buildFeeBumpEnvelope(inner, "SABCDEF", 100_000);
    expect(result).toContain(inner);
  });
});

// ── maybeFeeBump ──────────────────────────────────────────────────────────────

describe("maybeFeeBump", () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...savedEnv };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ── skip paths ─────────────────────────────────────────────────────────────

  it("returns bumped=false without error when failure is not fee-related", async () => {
    const stream = makeFeeFailedStream("REORG_DETECTED");
    const { feeBump } = await maybeFeeBump({ stream, alert: false });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toBeUndefined();
  });

  it("does not call fetcher when failure is not fee-related", async () => {
    const stream = makeFeeFailedStream("REORG_DETECTED");
    const mockFetch = jest.fn();
    await maybeFeeBump({ stream, alert: false }, mockFetch as unknown as typeof fetch);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── config-error paths ─────────────────────────────────────────────────────

  it("returns error and bumped=false when FEE_BUMP_SECRET_KEY is missing", async () => {
    delete process.env.FEE_BUMP_SECRET_KEY;
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("FEE_BUMP_SECRET_KEY");
  });

  it("logs a warning when config is invalid", async () => {
    delete process.env.FEE_BUMP_SECRET_KEY;
    const stream = makeFeeFailedStream();
    await maybeFeeBump({ stream, alert: true });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("configuration invalid"),
      expect.objectContaining({ stream_id: stream.id }),
    );
  });

  it("returns error when secret key has wrong prefix", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "GABCDEF_NOT_A_SECRET";
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Stellar secret key");
  });

  it("returns error when HORIZON_URL is invalid", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.HORIZON_URL = "not-a-url";
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("valid URL");
  });

  it("returns error when FEE_BUMP_MAX_FEE is invalid", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.FEE_BUMP_MAX_FEE = "0";
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
  });

  // ── no-hash path ───────────────────────────────────────────────────────────

  it("returns error when both settlementTxHash fields are absent", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    stream.settlementTxHash = undefined;
    if (stream.withdrawal) {
      stream.withdrawal.settlementTxHash = undefined;
    }
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("No settlement tx hash");
  });

  it("uses withdrawal.settlementTxHash as fallback when stream hash absent", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    stream.settlementTxHash = undefined;
    // withdrawal.settlementTxHash = "abc123" from helper
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ envelope_xdr: "xdr1" }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ hash: "newhash1" }), { status: 200 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(true);
  });

  // ── horizon-fetch failure paths ────────────────────────────────────────────

  it("returns error on non-2xx response from Horizon tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Failed to fetch original tx");
    expect(feeBump.error).toContain("404");
  });

  it("logs an error on Horizon tx fetch failure", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("horizon fetch failed"),
      expect.objectContaining({ stream_id: stream.id }),
    );
  });

  it("returns error when Horizon response has no envelope_xdr", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ hash: "abc" }), { status: 200 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("envelope_xdr");
  });

  it("returns error on network error during tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error("DNS failure"));
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("DNS failure");
  });

  // ── submission failure paths ───────────────────────────────────────────────

  it("returns error on non-2xx submission response", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("submission rejected", { status: 400 }),
      );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Fee-bump submission failed");
    expect(feeBump.error).toContain("400");
  });

  it("logs an error on submission failure", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("tx_bad_seq", { status: 400 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("submission rejected"),
      expect.objectContaining({ stream_id: stream.id }),
    );
  });

  it("returns error when successful response has no hash field", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
      );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("no hash");
  });

  it("returns error on network error during submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error("Network unreachable"));
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Network unreachable");
  });

  // ── success path ───────────────────────────────────────────────────────────

  it("returns bumped=true and newTxHash on success", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash_abc" }), { status: 200 }),
      );
    const { feeBump, result } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(true);
    expect(feeBump.newTxHash).toBe("bumped_hash_abc");
    expect(result.stream.settlementTxHash).toBe("bumped_hash_abc");
  });

  it("updates withdrawal state to pending on success", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash_abc" }), { status: 200 }),
      );
    const { result } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(result.stream.withdrawal?.state).toBe("pending");
    expect(result.stream.withdrawal?.failureCode).toBeUndefined();
    expect(result.stream.withdrawal?.attempts).toBe(0);
    expect(result.stream.withdrawal?.settlementTxHash).toBe("bumped_hash_abc");
  });

  it("logs info on successful fee-bump", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash" }), { status: 200 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("successfully submitted"),
      expect.objectContaining({ stream_id: stream.id, new_tx_hash: "bumped_hash" }),
    );
  });

  it("does not log the secret key in any log call", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SSECRETKEY_MUST_NOT_APPEAR_IN_LOGS";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "inner_xdr" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "h1" }), { status: 200 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    const allCalls = [
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ];
    for (const [, meta] of allCalls) {
      expect(JSON.stringify(meta ?? {})).not.toContain("SSECRETKEY_MUST_NOT_APPEAR");
    }
  });

  it("uses the envelope_xdr as inner transaction in the fee-bump body", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    let capturedBody = "";
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "TESTENVELOPE" }), { status: 200 }),
      )
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        capturedBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify({ hash: "h2" }), { status: 200 });
      });
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    expect(capturedBody).toContain("TESTENVELOPE");
  });

  it("submits to the configured HORIZON_URL", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    process.env.HORIZON_URL = "https://custom-horizon.example.com";
    const stream = makeFeeFailedStream();
    const calledUrls: string[] = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return new Response(JSON.stringify({ envelope_xdr: "xdr" }), { status: 200 });
      }
      return new Response(JSON.stringify({ hash: "h3" }), { status: 200 });
    });
    await maybeFeeBump({ stream, alert: true }, mockFetch as unknown as typeof fetch);
    expect(calledUrls[0]).toContain("custom-horizon.example.com");
  });

  // ── non-Error thrown-value paths (String(err) branches) ───────────────────

  it("handles a non-Error thrown value during tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockRejectedValueOnce("raw string error");
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("raw string error");
  });

  it("handles a non-Error thrown value during submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = "SABCDEFG";
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: "xdr" }), { status: 200 }),
      )
      .mockRejectedValueOnce({ code: 42, reason: "unknown object thrown" });
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as unknown as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Fee-bump submission error");
  });
});
