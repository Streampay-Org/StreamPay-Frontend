import {
  buildCancellationRecord,
  computeCancellationSplit,
  type CancelErrorCode,
  type CancelInput,
} from "./cancel-stream";
import type { StreamStatus } from "@/app/types/openapi";

function makeCancelInput(overrides: Partial<CancelInput> = {}): CancelInput {
  return {
    totalAmount: 1_000n,
    releasedAmount: 200n,
    vestedAmount: 600n,
    token: "XLM",
    senderAddress: "GSENDERADDRESS000000000000000000000000000000000000000000",
    recipientAddress: "GRECIPIENTADDRESS000000000000000000000000000000000000000",
    ...overrides,
  };
}

describe("computeCancellationSplit", () => {
  describe("escrow conservation for odd and large values", () => {
    const conservationCases: Array<{
      label: string;
      totalAmount: bigint;
      releasedAmount: bigint;
      vestedAmount: bigint;
      expectedRecipientPayout: bigint;
      expectedSenderRefund: bigint;
    }> = [
      {
        label: "single stroop unvested (1n)",
        totalAmount: 1n,
        releasedAmount: 0n,
        vestedAmount: 0n,
        expectedRecipientPayout: 0n,
        expectedSenderRefund: 1n,
      },
      {
        label: "single stroop vested (1n)",
        totalAmount: 1n,
        releasedAmount: 0n,
        vestedAmount: 1n,
        expectedRecipientPayout: 1n,
        expectedSenderRefund: 0n,
      },
      {
        label: "odd small total (3n) split 1/2",
        totalAmount: 3n,
        releasedAmount: 0n,
        vestedAmount: 1n,
        expectedRecipientPayout: 1n,
        expectedSenderRefund: 2n,
      },
      {
        label: "odd small total (3n) with partial release",
        totalAmount: 3n,
        releasedAmount: 1n,
        vestedAmount: 2n,
        expectedRecipientPayout: 1n,
        expectedSenderRefund: 1n,
      },
      {
        label: "odd mid-size total (10_000_001n)",
        totalAmount: 10_000_001n,
        releasedAmount: 3_333_333n,
        vestedAmount: 6_666_667n,
        expectedRecipientPayout: 3_333_334n,
        expectedSenderRefund: 3_333_334n,
      },
      {
        label: "large power-of-two total (2n ** 100n)",
        totalAmount: 2n ** 100n,
        releasedAmount: 2n ** 98n + 1n,
        vestedAmount: 2n ** 99n + 3n,
        expectedRecipientPayout: 2n ** 98n + 2n,
        expectedSenderRefund: 2n ** 99n - 3n,
      },
      {
        label: "large odd total (2n ** 100n + 1n)",
        totalAmount: 2n ** 100n + 1n,
        releasedAmount: 1n,
        vestedAmount: 2n ** 99n,
        expectedRecipientPayout: 2n ** 99n - 1n,
        expectedSenderRefund: 2n ** 99n + 1n,
      },
    ];

    it.each(conservationCases)(
      "conserves escrow for $label",
      ({
        totalAmount,
        releasedAmount,
        vestedAmount,
        expectedRecipientPayout,
        expectedSenderRefund,
      }) => {
        const input = makeCancelInput({ totalAmount, releasedAmount, vestedAmount });
        const result = computeCancellationSplit({ status: "active" }, input);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const { recipientPayout, senderRefund, escrowDrained } = result.split;
        expect(recipientPayout).toBe(expectedRecipientPayout);
        expect(senderRefund).toBe(expectedSenderRefund);
        expect(recipientPayout + senderRefund).toBe(totalAmount - releasedAmount);
        expect(escrowDrained).toBe(totalAmount - releasedAmount);
        expect(escrowDrained).toBe(recipientPayout + senderRefund);
      },
    );
  });

  describe("stream status handling", () => {
    it.each<StreamStatus>(["active", "paused"])(
      "succeeds when stream status is '%s'",
      (status) => {
        const input = makeCancelInput({
          totalAmount: 1_000n,
          releasedAmount: 250n,
          vestedAmount: 700n,
        });
        const result = computeCancellationSplit({ status }, input);

        expect(result).toEqual({
          ok: true,
          split: {
            recipientPayout: 450n,
            senderRefund: 300n,
            escrowDrained: 750n,
          },
        });
      },
    );

    it("rejects 'draft' streams with STREAM_NOT_CANCELLABLE", () => {
      const result = computeCancellationSplit({ status: "draft" }, makeCancelInput());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe<CancelErrorCode>("STREAM_NOT_CANCELLABLE");
      expect(result.message).toMatch(/draft/i);
    });

    it.each<StreamStatus>([
      "ended",
      "cancelled",
      "settled" as StreamStatus,
      "withdrawn",
    ])("rejects terminal status '%s' with ALREADY_TERMINAL", (status) => {
      const result = computeCancellationSplit({ status }, makeCancelInput());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe<CancelErrorCode>("ALREADY_TERMINAL");
      expect(result.message).toContain(status);
    });
  });

  describe("escrow invariant validation and boundary cases", () => {
    const invalidCases: Array<{
      label: string;
      totalAmount: bigint;
      releasedAmount: bigint;
      vestedAmount: bigint;
    }> = [
      {
        label: "negative releasedAmount",
        totalAmount: 1_000n,
        releasedAmount: -1n,
        vestedAmount: 500n,
      },
      {
        label: "releasedAmount > vestedAmount",
        totalAmount: 1_000n,
        releasedAmount: 601n,
        vestedAmount: 600n,
      },
      {
        label: "vestedAmount > totalAmount",
        totalAmount: 1_000n,
        releasedAmount: 0n,
        vestedAmount: 1_001n,
      },
      {
        label: "all negative amounts",
        totalAmount: -1n,
        releasedAmount: -3n,
        vestedAmount: -2n,
      },
    ];

    it.each(invalidCases)(
      "rejects $label with INVALID_ESCROW_STATE",
      ({ totalAmount, releasedAmount, vestedAmount }) => {
        const input = makeCancelInput({ totalAmount, releasedAmount, vestedAmount });
        const result = computeCancellationSplit({ status: "active" }, input);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.code).toBe<CancelErrorCode>("INVALID_ESCROW_STATE");
        expect(result.message).toMatch(/invariant/i);
      },
    );

    const boundaryCases: Array<{
      label: string;
      totalAmount: bigint;
      releasedAmount: bigint;
      vestedAmount: bigint;
      expectedRecipientPayout: bigint;
      expectedSenderRefund: bigint;
      expectedEscrowDrained: bigint;
    }> = [
      {
        label: "vested === released (zero recipient payout leg)",
        totalAmount: 1_000n,
        releasedAmount: 400n,
        vestedAmount: 400n,
        expectedRecipientPayout: 0n,
        expectedSenderRefund: 600n,
        expectedEscrowDrained: 600n,
      },
      {
        label: "vested === total (zero sender refund leg)",
        totalAmount: 1_000n,
        releasedAmount: 400n,
        vestedAmount: 1_000n,
        expectedRecipientPayout: 600n,
        expectedSenderRefund: 0n,
        expectedEscrowDrained: 600n,
      },
      {
        label: "all amounts 0n",
        totalAmount: 0n,
        releasedAmount: 0n,
        vestedAmount: 0n,
        expectedRecipientPayout: 0n,
        expectedSenderRefund: 0n,
        expectedEscrowDrained: 0n,
      },
      {
        label: "total === vested === released (both legs 0n)",
        totalAmount: 5_000n,
        releasedAmount: 5_000n,
        vestedAmount: 5_000n,
        expectedRecipientPayout: 0n,
        expectedSenderRefund: 0n,
        expectedEscrowDrained: 0n,
      },
    ];

    it.each(boundaryCases)(
      "handles boundary case: $label",
      ({
        totalAmount,
        releasedAmount,
        vestedAmount,
        expectedRecipientPayout,
        expectedSenderRefund,
        expectedEscrowDrained,
      }) => {
        const input = makeCancelInput({ totalAmount, releasedAmount, vestedAmount });
        const result = computeCancellationSplit({ status: "active" }, input);

        expect(result).toEqual({
          ok: true,
          split: {
            recipientPayout: expectedRecipientPayout,
            senderRefund: expectedSenderRefund,
            escrowDrained: expectedEscrowDrained,
          },
        });
      },
    );
  });
});

describe("buildCancellationRecord", () => {
  const FIXED_ISO = "2026-05-15T12:34:56.789Z";

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXED_ISO));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stringifies bigint amounts, includes senderTxHash when provided, and sets ISO cancelledAt", () => {
    const input = makeCancelInput({
      totalAmount: 2n ** 100n,
      releasedAmount: 10_000_001n,
      vestedAmount: 2n ** 99n,
      token: "USDC:GISSUER",
    });
    const splitResult = computeCancellationSplit({ status: "active" }, input);
    expect(splitResult.ok).toBe(true);
    if (!splitResult.ok) return;

    const record = buildCancellationRecord(
      input,
      splitResult.split,
      "tx-recipient-123",
      "tx-sender-456",
    );

    expect(record).toStrictEqual({
      recipientPayout: splitResult.split.recipientPayout.toString(),
      senderRefund: splitResult.split.senderRefund.toString(),
      totalAmount: (2n ** 100n).toString(),
      alreadyReleased: "10000001",
      token: "USDC:GISSUER",
      recipientTxHash: "tx-recipient-123",
      senderTxHash: "tx-sender-456",
      cancelledAt: FIXED_ISO,
    });
    expect(Object.keys(record)).toEqual([
      "recipientPayout",
      "senderRefund",
      "totalAmount",
      "alreadyReleased",
      "token",
      "recipientTxHash",
      "senderTxHash",
      "cancelledAt",
    ]);
    expect(new Date(record.cancelledAt).toISOString()).toBe(FIXED_ISO);
  });

  it("omits senderTxHash key completely when undefined", () => {
    const input = makeCancelInput({
      totalAmount: 1_000n,
      releasedAmount: 200n,
      vestedAmount: 1_000n,
    });
    const splitResult = computeCancellationSplit({ status: "paused" }, input);
    expect(splitResult.ok).toBe(true);
    if (!splitResult.ok) return;

    const record = buildCancellationRecord(
      input,
      splitResult.split,
      "tx-recipient-only",
      undefined,
    );

    expect(record).toStrictEqual({
      recipientPayout: "800",
      senderRefund: "0",
      totalAmount: "1000",
      alreadyReleased: "200",
      token: "XLM",
      recipientTxHash: "tx-recipient-only",
      cancelledAt: FIXED_ISO,
    });
    expect("senderTxHash" in record).toBe(false);
    expect(Object.keys(record)).toEqual([
      "recipientPayout",
      "senderRefund",
      "totalAmount",
      "alreadyReleased",
      "token",
      "recipientTxHash",
      "cancelledAt",
    ]);
  });
});
