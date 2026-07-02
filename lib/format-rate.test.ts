import { formatStreamingRate } from "./format-rate";

describe("formatStreamingRate", () => {
  it("formats per-second rates into the first readable human unit", () => {
    expect(
      formatStreamingRate("0.0001388889 XLM / second", { locale: "en-US" }),
    ).toBe("0.50 XLM / hour");
  });

  it("supports plural and abbreviated second aliases", () => {
    expect(formatStreamingRate("0.0001388889 USDC / seconds", { locale: "en-US" })).toBe(
      "0.50 USDC / hour",
    );
    expect(formatStreamingRate("0.0001388889 USDC/sec", { locale: "en-US" })).toBe(
      "0.50 USDC / hour",
    );
  });

  it("uses day or week when hourly amounts are too small to scan", () => {
    expect(formatStreamingRate("0.0000003 XLM / second", { locale: "en-US" })).toBe(
      "0.02592 XLM / day",
    );
    expect(formatStreamingRate("0.000000001 XLM / second", { locale: "en-US" })).toBe(
      "0.0006048 XLM / week",
    );
  });

  it("formats bare numeric values with a source interval and fallback asset", () => {
    expect(
      formatStreamingRate("50", {
        asset: "USDC",
        locale: "en-US",
        sourceInterval: "month",
      }),
    ).toBe("50 USDC / month");
  });

  it("treats bare numeric values without a source interval as per-second rates", () => {
    expect(formatStreamingRate("0.0001388889", { locale: "en-US" })).toBe(
      "0.50 XLM / hour",
    );
  });

  it("normalizes already formatted rates without changing their cadence", () => {
    expect(formatStreamingRate("120 XLM / month", { locale: "en-US" })).toBe(
      "120 XLM / month",
    );
    expect(formatStreamingRate("32 XLM/weeks", { locale: "en-US" })).toBe(
      "32 XLM / week",
    );
  });

  it("falls back to the original value for invalid rates", () => {
    expect(formatStreamingRate("not-a-rate")).toBe("not-a-rate");
    expect(formatStreamingRate("-1 XLM / second")).toBe("-1 XLM / second");
  });
});
