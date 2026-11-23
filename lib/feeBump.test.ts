/** @jest-environment node */
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

jest.mock("server-only", () => ({}), { virtual: true });

import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { getNetworkProfile } from "@/app/lib/config/stellar";
import { makeInnerTransaction } from "./__fixtures__/feeBump";
const fixture = makeInnerTransaction();

import {
  isFeeRelatedFailure,
  maybeFeeBump,
  resolveFeeBumpConfig,
  buildFeeBumpEnvelope,
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
    settlementTxHash: fixture.hash,
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
    settlementTxHash: fixture.hash,
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

  it.each(["testnet", "mainnet"] as const)("derives the %s passphrase and Horizon URL from the profile", network => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.STELLAR_NETWORK = network;
    delete process.env.HORIZON_URL;
    const result = resolveFeeBumpConfig();
    expect(result).toMatchObject({ ok: true, config: {
      networkPassphrase: getNetworkProfile(network).passphrase,
      horizonUrl: getNetworkProfile(network).horizonUrl,
    } });
  });

  it.each([undefined, "future", "unknown"])("rejects unsupported or missing network %s", network => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    if (network === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = network;
    expect(resolveFeeBumpConfig()).toMatchObject({ ok: false, error: expect.stringContaining("STELLAR_NETWORK") });
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
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    delete process.env.HORIZON_URL;
    delete process.env.FEE_BUMP_MAX_FEE;
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secretKey).toBe(fixture.payer.secret());
      expect(result.config.horizonUrl).toBe("https://horizon-testnet.stellar.org");
      expect(result.config.maxFee).toBe(100_000);
    }
  });

  it("accepts a custom valid HORIZON_URL", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.horizonUrl).toBe("https://horizon.stellar.org");
    }
  });

  it("returns error for a non-URL HORIZON_URL", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.HORIZON_URL = "not-a-url";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not a valid URL");
    }
  });

  it("returns error for a non-http HORIZON_URL protocol", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.HORIZON_URL = "ftp://horizon.example.com";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("http(s) protocol");
    }
  });

  it("accepts a custom valid FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.FEE_BUMP_MAX_FEE = "200000";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.maxFee).toBe(200_000);
    }
  });

  it("returns error for a non-integer FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.FEE_BUMP_MAX_FEE = "abc";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("positive integer");
    }
  });

  it("returns error for a zero FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.FEE_BUMP_MAX_FEE = "0";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
  });

  it("returns error for a negative FEE_BUMP_MAX_FEE", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.FEE_BUMP_MAX_FEE = "-100";
    const result = resolveFeeBumpConfig();
    expect(result.ok).toBe(false);
  });

  it("returns error when FEE_BUMP_MAX_FEE exceeds the ceiling", () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
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
  async function build(f = fixture, fee = 100_000, passphrase = f.passphrase) {
    return buildFeeBumpEnvelope(f.xdr, f.payer.secret(), fee, passphrase, f.hash);
  }

  it.each([1, 3])("signs a real envelope and preserves %i inner operations", async operations => {
    const f = makeInnerTransaction({ operations });
    const result = await build(f);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const outer = TransactionBuilder.fromXDR(result.xdr, f.passphrase);
    expect(outer).toBeInstanceOf(FeeBumpTransaction);
    if (!(outer instanceof FeeBumpTransaction)) throw new Error("Expected fee bump");
    expect(outer.feeSource).toBe(f.payer.publicKey());
    expect(outer.fee).toBe(String(100_000 * (operations + 1)));
    expect(outer.innerTransaction.hash().toString("hex")).toBe(f.hash);
    expect(outer.innerTransaction.toXDR()).toBe(f.xdr);
    expect(outer.signatures).toHaveLength(1);
    expect(f.payer.verify(outer.hash(), outer.signatures[0].signature())).toBe(true);
    expect(result.xdr).not.toContain(f.payer.secret());
  });

  it("rejects malformed XDR without throwing or exposing the key", async () => {
    await expect(buildFeeBumpEnvelope("not-xdr", fixture.payer.secret(), 100, fixture.passphrase, fixture.hash))
      .resolves.toMatchObject({ ok: false, error: { code: "INVALID_XDR" } });
  });

  it("rejects an already fee-bumped inner envelope", async () => {
    const outer = await build();
    if (!outer.ok) throw new Error(outer.error.message);
    await expect(buildFeeBumpEnvelope(outer.xdr, fixture.payer.secret(), 100_000, fixture.passphrase, fixture.hash))
      .resolves.toMatchObject({ ok: false, error: { code: "ALREADY_FEE_BUMPED" } });
  });

  it("rejects the wrong network using the original Horizon hash", async () => {
    await expect(build(fixture, 100_000, getNetworkProfile("mainnet").passphrase))
      .resolves.toMatchObject({ ok: false, error: { code: "NETWORK_MISMATCH" } });
  });

  it("rejects unsigned transactions", async () => {
    await expect(build(makeInnerTransaction({ signed: false })))
      .resolves.toMatchObject({ ok: false, error: { code: "UNSIGNED_INNER" } });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 10_000_001])("rejects out-of-range base fee %s", async fee => {
    await expect(build(fixture, fee)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_FEE" } });
  });

  it("rejects a cap below the inner base fee and accepts equality", async () => {
    const f = makeInnerTransaction({ fee: 200, operations: 3 });
    await expect(build(f, 199)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_FEE" } });
    await expect(build(f, 200)).resolves.toMatchObject({ ok: true });
  });

  it("accepts the configured ceiling", async () => {
    await expect(build(fixture, 10_000_000)).resolves.toMatchObject({ ok: true });
  });

  it("preserves Soroban resource fees and the signed inner envelope", async () => {
    const f = makeInnerTransaction({ resourceFee: 5000 });
    const result = await build(f, 200);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const outer = TransactionBuilder.fromXDR(result.xdr, f.passphrase) as FeeBumpTransaction;
    expect(outer.innerTransaction.toXDR()).toBe(f.xdr);
    expect(outer.fee).toBe("5400");
  });

  it("returns a safe typed error for an invalid secret", async () => {
    const secret = "SINVALID_SECRET";
    const result = await buildFeeBumpEnvelope(fixture.xdr, secret, 1000, fixture.passphrase, fixture.hash);
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_KEY" } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

it("does not load the SDK when the server module is imported", () => {
  const loadSdk = jest.fn(() => { throw new Error("SDK loaded eagerly"); });
  jest.doMock("@stellar/stellar-sdk", loadSdk);
  try {
    jest.isolateModules(() => { jest.requireActual("./feeBump"); });
    expect(loadSdk).not.toHaveBeenCalled();
  } finally {
    jest.dontMock("@stellar/stellar-sdk");
  }
});

it("refuses to sign in a browser runtime", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    await expect(buildFeeBumpEnvelope(fixture.xdr, fixture.payer.secret(), 1000, fixture.passphrase, fixture.hash))
      .resolves.toMatchObject({ ok: false, error: { code: "SERVER_ONLY" } });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

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
    await maybeFeeBump({ stream, alert: false }, mockFetch);
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
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.HORIZON_URL = "not-a-url";
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("valid URL");
  });

  it("returns error when FEE_BUMP_MAX_FEE is invalid", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.FEE_BUMP_MAX_FEE = "0";
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
  });

  // ── no-hash path ───────────────────────────────────────────────────────────

  it("returns error when both settlementTxHash fields are absent", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
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
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    stream.settlementTxHash = undefined;
    // withdrawal.settlementTxHash = "abc123" from helper
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
    ).mockResolvedValueOnce(
      new Response(JSON.stringify({ hash: "newhash1" }), { status: 200 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(true);
  });

  // ── horizon-fetch failure paths ────────────────────────────────────────────

  it("returns error on non-2xx response from Horizon tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Failed to fetch original tx");
    expect(feeBump.error).toContain("404");
  });

  it("logs an error on Horizon tx fetch failure", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );
    await maybeFeeBump({ stream, alert: true }, mockFetch);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("horizon fetch failed"),
      expect.objectContaining({ stream_id: stream.id }),
    );
  });

  it("returns error when Horizon response has no envelope_xdr", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ hash: "abc" }), { status: 200 }),
    );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("envelope_xdr");
  });

  it("returns error on network error during tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockRejectedValueOnce(new Error("DNS failure"));
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("DNS failure");
  });

  // ── submission failure paths ───────────────────────────────────────────────

  it("returns error on non-2xx submission response", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("submission rejected", { status: 400 }),
      );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Fee-bump submission failed");
    expect(feeBump.error).toContain("400");
  });

  it("logs an error on submission failure", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response("tx_bad_seq", { status: 400 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("submission rejected"),
      expect.objectContaining({ stream_id: stream.id }),
    );
  });

  it("returns error when successful response has no hash field", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
      );
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("no hash");
  });

  it("returns error on network error during submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error("Network unreachable"));
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Network unreachable");
  });

  // ── success path ───────────────────────────────────────────────────────────

  it("returns bumped=true and newTxHash on success", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash_abc" }), { status: 200 }),
      );
    const { feeBump, result } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(true);
    expect(feeBump.newTxHash).toBe("bumped_hash_abc");
    expect(result.stream.settlementTxHash).toBe("bumped_hash_abc");
  });

  it("updates withdrawal state to pending on success", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash_abc" }), { status: 200 }),
      );
    const { result } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(result.stream.withdrawal?.state).toBe("pending");
    expect(result.stream.withdrawal?.failureCode).toBeUndefined();
    expect(result.stream.withdrawal?.attempts).toBe(0);
    expect(result.stream.withdrawal?.settlementTxHash).toBe("bumped_hash_abc");
  });

  it("logs info on successful fee-bump", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "bumped_hash" }), { status: 200 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch);
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
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hash: "h1" }), { status: 200 }),
      );
    await maybeFeeBump({ stream, alert: true }, mockFetch);
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
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    let capturedBody = "";
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockImplementationOnce(async (_url: string, init?: RequestInit) => {
        capturedBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify({ hash: "h2" }), { status: 200 });
      });
    await maybeFeeBump({ stream, alert: true }, mockFetch);
    const tx = new URLSearchParams(capturedBody).get("tx");
    expect(tx).not.toBeNull();
    const outer = TransactionBuilder.fromXDR(tx!, fixture.passphrase) as FeeBumpTransaction;
    expect(outer.innerTransaction.toXDR()).toBe(fixture.xdr);
  });

  it("submits to the configured HORIZON_URL", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    process.env.HORIZON_URL = "https://custom-horizon.example.com";
    const stream = makeFeeFailedStream();
    const calledUrls: string[] = [];
    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 });
      }
      return new Response(JSON.stringify({ hash: "h3" }), { status: 200 });
    });
    await maybeFeeBump({ stream, alert: true }, mockFetch);
    expect(calledUrls[0]).toContain("custom-horizon.example.com");
  });

  // ── non-Error thrown-value paths (String(err) branches) ───────────────────

  it("handles a non-Error thrown value during tx fetch", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn().mockRejectedValueOnce("raw string error");
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("raw string error");
  });

  it("handles a non-Error thrown value during submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ envelope_xdr: fixture.xdr }), { status: 200 }),
      )
      .mockRejectedValueOnce({ code: 42, reason: "unknown object thrown" });
    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Fee-bump submission error");
  });
  it.each(["malformed", "wrong-network", "unsigned", "already-bumped", "fee-limit", "invalid-key"])(
    "returns bumped=false without submission or mutation for %s", async kind => {
      process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
      let xdr = fixture.xdr;
      if (kind === "malformed") xdr = "not-xdr";
      if (kind === "wrong-network") process.env.STELLAR_NETWORK = "mainnet";
      if (kind === "unsigned") xdr = makeInnerTransaction({ signed: false }).xdr;
      if (kind === "fee-limit") process.env.FEE_BUMP_MAX_FEE = "99";
      if (kind === "invalid-key") process.env.FEE_BUMP_SECRET_KEY = "SINVALID_KEY";
      if (kind === "already-bumped") {
        const built = await buildFeeBumpEnvelope(fixture.xdr, fixture.payer.secret(), 1000, fixture.passphrase, fixture.hash);
        if (!built.ok) throw new Error(built.error.message);
        xdr = built.xdr;
      }
      const stream = makeFeeFailedStream();
      const before = JSON.stringify(stream);
      const fetcher = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ envelope_xdr: xdr })));
      const { feeBump } = await maybeFeeBump({ stream, alert: true }, fetcher);
      expect(feeBump).toMatchObject({ bumped: false, error: expect.any(String) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(stream)).toBe(before);
    },
  );

  it.each(["fetch", "response", "submit"])("redacts the secret from %s errors and logs", async stage => {
    const secret = fixture.payer.secret();
    process.env.FEE_BUMP_SECRET_KEY = secret;
    const fetcher = jest.fn();
    if (stage === "fetch") fetcher.mockRejectedValueOnce(new Error(`failure ${secret}`));
    else {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ envelope_xdr: fixture.xdr })));
      if (stage === "response") fetcher.mockResolvedValueOnce(new Response(`failure ${secret}`, { status: 400 }));
      else fetcher.mockRejectedValueOnce(new Error(`failure ${secret}`));
    }
    const { feeBump } = await maybeFeeBump({ stream: makeFeeFailedStream(), alert: true }, fetcher);
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("[REDACTED]");
    expect(feeBump.error).not.toContain(secret);
    expect(JSON.stringify([mockLogger.info.mock.calls, mockLogger.warn.mock.calls, mockLogger.error.mock.calls])).not.toContain(secret);
  });

});
