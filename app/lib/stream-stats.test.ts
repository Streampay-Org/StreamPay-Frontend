import { aggregateStreamStats, type StreamStatsInput } from "./stream-stats";

describe("aggregateStreamStats", () => {
  it("returns zero counts and empty totals for zero streams", () => {
    const result = aggregateStreamStats([]);
    expect(result).toEqual({
      counts: {
        draft: 0,
        active: 0,
        paused: 0,
        ended: 0,
        withdrawn: 0,
        cancelled: 0,
      },
      totals: {},
      skipped: 0,
    });
  });

  it("aggregates counts by status and totals per token with mixed tokens", () => {
    const streams: StreamStatsInput[] = [
      { status: "active", token: "XLM", totalAmount: "10000000", releasedAmount: "2500000" },
      { status: "active", token: "USDC", totalAmount: "50000000", releasedAmount: "10000000" },
      { status: "paused", token: "XLM", totalAmount: "20000000", releasedAmount: "5000000" },
      { status: "ended", token: "USDC", totalAmount: "30000000", releasedAmount: "30000000" },
      { status: "draft", token: "XLM" },
      { status: "cancelled", token: "XLM", totalAmount: "1000", releasedAmount: "500" },
      { status: "withdrawn", token: "USDC", totalAmount: "2000", releasedAmount: "2000" },
    ];

    const result = aggregateStreamStats(streams);

    expect(result.counts).toEqual({
      draft: 1,
      active: 2,
      paused: 1,
      ended: 1,
      withdrawn: 1,
      cancelled: 1,
    });
    expect(result.totals).toEqual({
      XLM: { escrowed: "30001000", released: "7500500" },
      USDC: { escrowed: "80002000", released: "40002000" },
    });
    expect(result.skipped).toBe(0);
  });

  it("maintains exact BigInt precision above Number.MAX_SAFE_INTEGER", () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991
    const huge1 = "9007199254740993000000001";
    const huge2 = "9007199254740993000000002";
    const expectedSum = (BigInt(huge1) + BigInt(huge2)).toString();

    const result = aggregateStreamStats([
      { status: "active", token: "XLM", totalAmount: huge1, releasedAmount: "1" },
      { status: "active", token: "XLM", totalAmount: huge2, releasedAmount: "2" },
    ]);

    expect(result.totals.XLM.escrowed).toBe(expectedSum);
    expect(result.totals.XLM.escrowed).toBe("18014398509481986000000003");
    expect(result.totals.XLM.released).toBe("3");
  });

  it("handles missing amount fields as 0n and defaults empty token to XLM", () => {
    const result = aggregateStreamStats([
      { status: "draft", token: "", totalAmount: undefined, releasedAmount: undefined },
      { status: "active", token: "XLM", totalAmount: "500" },
    ]);

    expect(result.counts.draft).toBe(1);
    expect(result.counts.active).toBe(1);
    expect(result.totals.XLM).toEqual({ escrowed: "500", released: "0" });
    expect(result.skipped).toBe(0);
  });

  it("skips unparsable amounts and increments skipped count", () => {
    const result = aggregateStreamStats([
      { status: "active", token: "XLM", totalAmount: "1000", releasedAmount: "200" },
      { status: "active", token: "XLM", totalAmount: "not-a-number", releasedAmount: "100" },
      { status: "paused", token: "XLM", totalAmount: "500", releasedAmount: "-50" },
      { status: "ended", token: "XLM", totalAmount: "12.34", releasedAmount: "0" },
      { status: "draft", token: "XLM", totalAmount: "", releasedAmount: "0" },
    ]);

    expect(result.counts).toEqual({
      draft: 1,
      active: 2,
      paused: 1,
      ended: 1,
      withdrawn: 0,
      cancelled: 0,
    });
    expect(result.totals.XLM).toEqual({ escrowed: "1000", released: "200" });
    expect(result.skipped).toBe(4);
  });

  it("aggregates 100k streams quickly without precision loss", () => {
    const count = 100_000;
    const streams: StreamStatsInput[] = new Array(count);
    for (let i = 0; i < count; i += 1) {
      streams[i] = {
        status: i % 2 === 0 ? "active" : "paused",
        token: i % 3 === 0 ? "USDC" : "XLM",
        totalAmount: "1000000000000000000",
        releasedAmount: "250000000000000000",
      };
    }

    const start = performance.now();
    const result = aggregateStreamStats(streams);
    const elapsedMs = performance.now() - start;

    expect(result.counts.active).toBe(50_000);
    expect(result.counts.paused).toBe(50_000);
    expect(result.skipped).toBe(0);
    expect(BigInt(result.totals.XLM.escrowed) + BigInt(result.totals.USDC.escrowed)).toBe(
      BigInt(count) * 1_000_000_000_000_000_000n,
    );
    expect(elapsedMs).toBeLessThan(2000);
  });
});
