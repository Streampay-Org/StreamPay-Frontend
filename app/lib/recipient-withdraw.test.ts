/** @jest-environment node */
import { computeWithdraw, resolveEscrowState } from "./recipient-withdraw";
import type { WithdrawInput } from "./recipient-withdraw";
import type { Stream } from "@/app/types/openapi";

const RECIPIENT = "GRECIPIENT000000000000000000000000000000000000000000000";
const OTHER_WALLET = "GOTHER000000000000000000000000000000000000000000000000";
const NOW = new Date("2026-04-28T12:00:00.000Z");

const endedStream: Pick<Stream, "status"> = { status: "ended" };

function input(overrides: Partial<WithdrawInput> = {}): WithdrawInput {
  return {
    totalAmount: 1_000n,
    releasedAmount: 0n,
    vestedAmount: 1_000n,
    requestedAmount: undefined,
    token: "XLM",
    recipientAddress: RECIPIENT,
    callerAddress: RECIPIENT,
    endTime: "2026-04-20T00:00:00.000Z",
    now: NOW,
    ...overrides,
  };
}

describe("computeWithdraw", () => {
  it("withdraws the full withdrawable balance when amount is omitted", () => {
    const outcome = computeWithdraw(endedStream, input({ vestedAmount: 750n }));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.amountPaidOut).toBe(750n);
    expect(outcome.result.newReleasedAmount).toBe(750n);
    expect(outcome.result.shouldMarkEnded).toBe(false);
  });

  it("withdraws an explicit partial amount and advances releasedAmount", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ releasedAmount: 100n, vestedAmount: 900n, requestedAmount: 250n }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.amountPaidOut).toBe(250n);
    expect(outcome.result.newReleasedAmount).toBe(350n);
  });

  it("marks the stream ended when fully drained at or after end time", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ releasedAmount: 900n, requestedAmount: 100n }),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.newReleasedAmount).toBe(1_000n);
    expect(outcome.result.shouldMarkEnded).toBe(true);
  });

  it("returns RECIPIENT_AUTH_REQUIRED when the caller is not the recipient", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ callerAddress: OTHER_WALLET }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "RECIPIENT_AUTH_REQUIRED" });
  });

  it("returns RECIPIENT_AUTH_REQUIRED when the caller is empty", () => {
    const outcome = computeWithdraw(endedStream, input({ callerAddress: "" }));

    expect(outcome).toMatchObject({ ok: false, code: "RECIPIENT_AUTH_REQUIRED" });
  });

  it("returns INVALID_STREAM_STATE for cancelled streams", () => {
    const outcome = computeWithdraw({ status: "cancelled" }, input());

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STREAM_STATE" });
  });

  it("returns INVALID_STREAM_STATE for already withdrawn streams", () => {
    const outcome = computeWithdraw({ status: "withdrawn" }, input());

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_STREAM_STATE" });
  });

  it("returns INVALID_ESCROW_STATE when releasedAmount exceeds vestedAmount", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ releasedAmount: 500n, vestedAmount: 400n }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_ESCROW_STATE" });
  });

  it("returns INVALID_ESCROW_STATE when vestedAmount exceeds totalAmount", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ totalAmount: 500n, vestedAmount: 600n }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_ESCROW_STATE" });
  });

  it("returns INVALID_ESCROW_STATE for a negative releasedAmount", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ releasedAmount: -1n }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "INVALID_ESCROW_STATE" });
  });

  it("returns NO_WITHDRAWABLE_BALANCE when everything is already released", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ releasedAmount: 1_000n, vestedAmount: 1_000n }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "NO_WITHDRAWABLE_BALANCE" });
  });

  it("returns ZERO_AMOUNT when an explicit amount of zero is requested", () => {
    const outcome = computeWithdraw(endedStream, input({ requestedAmount: 0n }));

    expect(outcome).toMatchObject({ ok: false, code: "ZERO_AMOUNT" });
  });

  it("returns OVER_WITHDRAW when the requested amount exceeds withdrawable", () => {
    const outcome = computeWithdraw(
      endedStream,
      input({ vestedAmount: 400n, requestedAmount: 401n }),
    );

    expect(outcome).toMatchObject({ ok: false, code: "OVER_WITHDRAW" });
  });
});

describe("resolveEscrowState", () => {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  /** An ended stream with a 30-day linear vesting window starting at `startTime`. */
  function streamFrom(startTime: string): Stream {
    const endTime = new Date(Date.parse(startTime) + THIRTY_DAYS_MS).toISOString();
    return {
      id: "stream-test",
      recipient: RECIPIENT,
      rate: "1",
      schedule: "month",
      status: "ended",
      token: "XLM",
      totalAmount: "1000",
      releasedAmount: "250",
      startTime,
      endTime,
      createdAt: startTime,
      updatedAt: startTime,
    };
  }

  it("vests linearly over the persisted vesting window", () => {
    const state = resolveEscrowState(
      streamFrom("2026-04-13T12:00:00.000Z"),
      NOW,
    );

    expect(state).toEqual({
      ok: true,
      value: { total: 1_000n, released: 250n, vested: 500n },
    });
  });

  it("caps the vested amount at the total after the window completes", () => {
    const state = resolveEscrowState(
      streamFrom("2026-01-01T00:00:00.000Z"),
      NOW,
    );

    expect(state.ok && state.value.vested).toBe(1_000n);
  });

  it("fails closed with ESCROW_UNKNOWN when no window or vested snapshot exists", () => {
    const { startTime: _start, endTime: _end, ...unknownWindow } = streamFrom(
      "2026-04-13T12:00:00.000Z",
    );

    expect(resolveEscrowState(unknownWindow, NOW)).toEqual({
      ok: false,
      code: "ESCROW_UNKNOWN",
    });
  });
});

