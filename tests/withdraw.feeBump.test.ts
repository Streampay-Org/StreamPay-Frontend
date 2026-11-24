/** @jest-environment node */
/**
 * withdraw.feeBump.test.ts
 *
 * Unit tests for the fee-bump logic in `lib/feeBump.ts`.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { isFeeRelatedFailure, maybeFeeBump } from "@/lib/feeBump";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { makeInnerTransaction } from "@/lib/__fixtures__/feeBump";
const fixture = makeInnerTransaction();
import type { Stream } from "@/app/types/openapi";

// ── Helpers ────────────────────────────────────────────────────────────────

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
  } as Stream;
}

function makeFeeFailedStream(): Stream {
  return makeStream({
    withdrawal: {
      state: "failed",
      failureCode: "tx_insufficient_fee",
      requestedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      attempts: 1,
      settlementTxHash: fixture.hash,
    },
  });
}

// ── isFeeRelatedFailure ────────────────────────────────────────────────────

describe("isFeeRelatedFailure", () => {
  it("returns true for tx_insufficient_fee", () => {
    const stream = makeFeeFailedStream();
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns true for tx_too_late", () => {
    const stream = makeStream({
      withdrawal: {
        state: "failed",
        failureCode: "tx_too_late",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
        settlementTxHash: fixture.hash,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns true for INSUFFICIENT_FEE", () => {
    const stream = makeStream({
      withdrawal: {
        state: "failed",
        failureCode: "INSUFFICIENT_FEE",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
        settlementTxHash: fixture.hash,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(true);
  });

  it("returns false for non-fee failures", () => {
    const stream = makeStream({
      withdrawal: {
        state: "failed",
        failureCode: "REORG_DETECTED",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
        settlementTxHash: fixture.hash,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false for pending state", () => {
    const stream = makeStream({
      withdrawal: {
        state: "pending",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
        settlementTxHash: fixture.hash,
      },
    });
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });

  it("returns false when no withdrawal exists", () => {
    const stream = makeStream();
    expect(isFeeRelatedFailure({ stream, alert: false })).toBe(false);
  });
});

// ── maybeFeeBump ───────────────────────────────────────────────────────────

describe("maybeFeeBump", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  it("skips when the failure is not fee-related", async () => {
    const stream = makeStream({
      withdrawal: {
        state: "failed",
        failureCode: "REORG_DETECTED",
        requestedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        attempts: 1,
        settlementTxHash: fixture.hash,
      },
    });
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toBeUndefined();
  });

  it("returns error when FEE_BUMP_SECRET_KEY is not set", async () => {
    delete process.env.FEE_BUMP_SECRET_KEY;
    const stream = makeFeeFailedStream();
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("FEE_BUMP_SECRET_KEY");
  });

  it("returns error when no settlement tx hash is available", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();
    stream.settlementTxHash = undefined as unknown as string;
    if (stream.withdrawal) {
      stream.withdrawal.settlementTxHash = undefined;
    }
    const { feeBump } = await maybeFeeBump({ stream, alert: true });
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("No settlement tx hash");
  });

  it("handles Horizon fetch failure gracefully", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();

    const mockFetch = async () => {
      return new Response(null, { status: 404 });
    };

    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as typeof fetch,
    );
    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Failed to fetch original tx");
  });

  it("handles successful fee-bump submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();

    let callCount = 0;
    const mockFetch = async (_url: string, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: fetch original tx envelope
        return new Response(
          JSON.stringify({ envelope_xdr: fixture.xdr }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second call carries a real envelope preserving the signed inner tx.
      const xdr = new URLSearchParams(String(init?.body)).get("tx");
      expect(xdr).not.toBeNull();
      const outer = TransactionBuilder.fromXDR(xdr!, fixture.passphrase) as FeeBumpTransaction;
      expect(outer).toBeInstanceOf(FeeBumpTransaction);
      expect(outer.innerTransaction.toXDR()).toBe(fixture.xdr);
      expect(fixture.payer.verify(outer.hash(), outer.signatures[0].signature())).toBe(true);
      return new Response(
        JSON.stringify({ hash: "new_fee_bumped_hash" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const { result, feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as typeof fetch,
    );

    expect(feeBump.bumped).toBe(true);
    expect(feeBump.newTxHash).toBe("new_fee_bumped_hash");
    expect(result.stream.settlementTxHash).toBe("new_fee_bumped_hash");
    expect(result.stream.withdrawal?.state).toBe("pending");
    expect(result.stream.withdrawal?.failureCode).toBeUndefined();
  });

  it("handles fee-bump submission failure", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ envelope_xdr: fixture.xdr }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("submission error", { status: 500 });
    };

    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as typeof fetch,
    );

    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Fee-bump submission failed");
  });

  it("handles network error during submission", async () => {
    process.env.FEE_BUMP_SECRET_KEY = fixture.payer.secret();
    const stream = makeFeeFailedStream();

    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ envelope_xdr: fixture.xdr }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error("Network unreachable");
    };

    const { feeBump } = await maybeFeeBump(
      { stream, alert: true },
      mockFetch as typeof fetch,
    );

    expect(feeBump.bumped).toBe(false);
    expect(feeBump.error).toContain("Network unreachable");
  });
});
