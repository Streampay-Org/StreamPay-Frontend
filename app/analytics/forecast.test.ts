import fc from "fast-check";
import { formatBigInt } from "@/lib/format-bigint";
import { projectDailyFlows, type ForecastStream } from "./forecast";

const WALLET = "G-WALLET";
const OTHER = "G-OTHER";
const FROM = new Date("2026-03-07T18:00:00.000Z");

function activeStream(overrides: Partial<ForecastStream> = {}): ForecastStream {
  return {
    status: "active",
    rate: "24",
    schedule: "day",
    senderAddress: OTHER,
    recipient: WALLET,
    ...overrides,
  };
}

describe("projectDailyFlows", () => {
  it.each([
    ["daily decimal precision", "0.0000001", "day", 1n],
    ["weekly rate", "7", "week", 10_000_000n],
    ["monthly rate", "30", "month", 10_000_000n],
    ["amount above safe integer", "900719925.4740993", "day", 9_007_199_254_740_993n],
  ])("projects %s exactly", (_label, rate, schedule, expectedPerDay) => {
    const [flow] = projectDailyFlows(
      [activeStream({ rate, schedule })],
      WALLET,
      new Date("2026-03-08T00:00:00.000Z"),
      1,
    );

    expect(flow.incoming).toBe(expectedPerDay);
    expect(flow.outgoing).toBe(0n);
  });

  it("counts partial UTC days and clamps to start and end across a month boundary", () => {
    const flows = projectDailyFlows(
      [
        activeStream({
          rate: "24",
          startedAt: "2026-03-31T12:00:00.000Z",
          endsAt: "2026-04-01T06:00:00.000Z",
        }),
      ],
      WALLET,
      new Date("2026-03-31T00:00:00.000Z"),
      2,
    );

    expect(flows).toEqual([
      { date: "2026-03-31", incoming: 120_000_000n, outgoing: 0n },
      { date: "2026-04-01", incoming: 60_000_000n, outgoing: 0n },
    ]);
  });

  it("treats a DST transition as consecutive UTC days", () => {
    const flows = projectDailyFlows(
      [activeStream()],
      WALLET,
      new Date("2026-03-08T00:00:00.000Z"),
      2,
    );

    expect(flows.map(({ date, incoming }) => [date, incoming])).toEqual([
      ["2026-03-08", 240_000_000n],
      ["2026-03-09", 240_000_000n],
    ]);
  });

  it.each(["paused", "ended", "withdrawn", "cancelled", "draft"] as const)(
    "projects no flow for %s streams",
    (status) => {
      const [flow] = projectDailyFlows(
        [activeStream({ status })],
        WALLET,
        new Date("2026-03-08T00:00:00.000Z"),
        1,
      );
      expect(flow.incoming).toBe(0n);
      expect(flow.outgoing).toBe(0n);
    },
  );

  it("projects outgoing streams, excludes self-streams, and honors remaining total amount", () => {
    const flows = projectDailyFlows(
      [
        activeStream({
          senderAddress: WALLET,
          recipient: OTHER,
          totalAmount: "250000000",
          releasedAmount: "50000000",
        }),
        activeStream({ senderAddress: WALLET, recipient: WALLET }),
      ],
      WALLET,
      new Date("2026-03-08T00:00:00.000Z"),
      2,
    );

    expect(flows.map((flow) => flow.outgoing)).toEqual([200_000_000n, 0n]);
    expect(flows.map((flow) => flow.incoming)).toEqual([0n, 0n]);
  });

  it("returns an empty result for a zero-length range", () => {
    expect(projectDailyFlows([activeStream()], WALLET, FROM, 0)).toEqual([]);
  });

  it("never forecasts more than the stream's total amount", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        (rate, totalAmount) => {
          const flows = projectDailyFlows(
            [
              activeStream({
                rate: formatBigInt(rate),
                totalAmount: totalAmount.toString(),
              }),
            ],
            WALLET,
            new Date("2026-01-01T00:00:00.000Z"),
            90,
          );
          const sum = flows.reduce((amount, flow) => amount + flow.incoming, 0n);
          return sum <= totalAmount;
        },
      ),
    );
  });
});
