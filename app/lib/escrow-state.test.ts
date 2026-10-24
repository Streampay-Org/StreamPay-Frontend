import fc from "fast-check";
import { computeCancellationSplit } from "./cancel-stream";
import { escrowNow, resolveEscrowState, vestedAmount } from "./escrow-state";
import type { Stream } from "@/app/types/openapi";

const start = "2026-01-01T00:00:00.000Z";
const end = "2026-01-02T00:00:00.000Z";
const base: Stream = {
  id: "stream-test",
  recipient: "GRECIPIENT",
  senderAddress: "GSENDER",
  rate: "1",
  schedule: "day",
  status: "active",
  createdAt: start,
  updatedAt: start,
  token: "XLM",
  totalAmount: "2000000000",
  releasedAmount: "0",
  startTime: start,
  endTime: end,
};

describe("resolveEscrowState", () => {
  it("captures a valid current instant for callers", () => {
    expect(Number.isFinite(escrowNow().getTime())).toBe(true);
  });

  it("computes linear vesting exactly from raw units", () => {
    expect(resolveEscrowState(base, new Date("2026-01-01T06:00:00.000Z"))).toEqual({
      ok: true,
      value: { total: 2_000_000_000n, released: 0n, vested: 500_000_000n },
    });
    expect(resolveEscrowState(base, new Date(start))).toMatchObject({ value: { vested: 0n } });
    expect(resolveEscrowState(base, new Date(end))).toMatchObject({ value: { vested: 2_000_000_000n } });
    expect(resolveEscrowState(base, new Date("2025-12-31T00:00:00.000Z"))).toMatchObject({ value: { vested: 0n } });
  });

  it("freezes vesting at pausedAt", () => {
    const paused = { ...base, status: "paused" as const, pausedAt: "2026-01-01T06:00:00.000Z" };
    expect(resolveEscrowState(paused, new Date("2026-01-01T18:00:00.000Z")))
      .toMatchObject({ value: { vested: 500_000_000n } });
  });

  it("excludes completed pauses after the stream resumes", () => {
    const resumed = { ...base, pausedDurationMs: 3_600_000 };
    expect(resolveEscrowState(resumed, new Date("2026-01-01T07:00:00.000Z")))
      .toMatchObject({ value: { vested: 500_000_000n } });
    expect(resolveEscrowState(resumed, new Date("2026-01-02T01:00:00.000Z")))
      .toMatchObject({ value: { vested: 2_000_000_000n } });
  });

  it("uses the persisted vested snapshot for a legacy stream without dates", () => {
    expect(resolveEscrowState({ ...base, startTime: undefined, endTime: undefined, vestedAmount: "7" }, new Date(end)))
      .toMatchObject({ value: { vested: 7n } });
  });

  it.each([
    { totalAmount: undefined },
    { totalAmount: "not-an-amount" },
    { releasedAmount: undefined },
    { releasedAmount: "1.5" },
    { startTime: undefined },
    { endTime: "invalid" },
    { endTime: start },
    { pausedAt: "invalid" },
    { pausedDurationMs: -1 },
    { pausedDurationMs: 1.5 },
    { startTime: undefined, endTime: undefined, vestedAmount: undefined },
  ])("returns ESCROW_UNKNOWN for missing or malformed data: %o", (change) => {
    expect(resolveEscrowState({ ...base, ...change }, new Date(end)))
      .toEqual({ ok: false, code: "ESCROW_UNKNOWN" });
  });

  it("rejects an invalid clock", () => {
    expect(resolveEscrowState(base, new Date(NaN))).toEqual({ ok: false, code: "ESCROW_UNKNOWN" });
  });

  it("preserves amounts above 2^53 without floating point conversion", () => {
    const total = 9_007_199_254_740_993n;
    const result = resolveEscrowState({ ...base, totalAmount: total.toString() }, new Date("2026-01-01T06:00:00.000Z"));
    expect(result).toEqual({
      ok: true,
      value: { total, released: 0n, vested: total / 4n },
    });
  });

  it("conserves raw escrow units for random valid values and times", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 1n, max: (1n << 127n) - 1n }),
      fc.integer({ min: 0, max: 86_400_000 }),
      fc.integer({ min: 0, max: 100 }),
      (total, elapsed, releasedPercent) => {
        const vested = total * BigInt(elapsed) / 86_400_000n;
        const released = vested * BigInt(releasedPercent) / 100n;
        const state = resolveEscrowState(
          { ...base, totalAmount: total.toString(), releasedAmount: released.toString() },
          new Date(Date.parse(start) + elapsed),
        );
        expect(state.ok).toBe(true);
        if (!state.ok) return;
        const result = computeCancellationSplit(base, {
          totalAmount: state.value.total,
          releasedAmount: state.value.released,
          vestedAmount: state.value.vested,
          token: "XLM",
          senderAddress: "GSENDER",
          recipientAddress: "GRECIPIENT",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.split.recipientPayout + result.split.senderRefund)
          .toBe(total - released);
      },
    ));
  });
});

describe("contract-style vestedAmount compatibility", () => {
  const timed = { ...base, total: "200", startTime: "0", endTime: "100", totalPausedMs: "0" };

  it("handles draft, active, paused and completed windows with integer arithmetic", () => {
    expect(vestedAmount({ ...timed, status: "draft" }, 50)).toEqual({ ok: true, value: 0n });
    expect(vestedAmount(timed, 25n)).toEqual({ ok: true, value: 50n });
    expect(vestedAmount(timed, -1)).toEqual({ ok: true, value: 0n });
    expect(vestedAmount(timed, 101)).toEqual({ ok: true, value: 200n });
    expect(vestedAmount({ ...timed, pausedAt: "20" }, 50)).toEqual({ ok: true, value: 40n });
    expect(vestedAmount({ ...timed, totalPausedMs: "10" }, 50)).toEqual({ ok: true, value: 80n });
    expect(vestedAmount({ ...timed, totalPausedMs: "60" }, 50)).toEqual({ ok: true, value: 0n });
    expect(vestedAmount({ ...timed, totalPausedMs: "-10" }, 100)).toEqual({ ok: true, value: 200n });
    expect(vestedAmount({ ...timed, endTime: "0" }, 50)).toEqual({ ok: true, value: 0n });
  });

  it("accepts integer timing representations and rejects unknown schedules", () => {
    expect(vestedAmount({ ...timed, total: 200n, startTime: " 0 ", endTime: "100" }, 50))
      .toEqual({ ok: true, value: 100n });
    expect(vestedAmount({ ...timed, total: 200, startTime: 0, endTime: 100 }, 50))
      .toEqual({ ok: true, value: 100n });
    for (const change of [
      { total: undefined },
      { startTime: undefined },
      { endTime: undefined },
      { endTime: "" },
      { endTime: "bad" },
      { endTime: Number.NaN },
      { endTime: 1.5 },
      { endTime: null },
    ]) {
      expect(vestedAmount({ ...timed, ...change } as typeof timed, 50))
        .toEqual({ ok: false, code: "ESCROW_UNKNOWN" });
    }
  });
});
