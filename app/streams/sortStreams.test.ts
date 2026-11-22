import { isSortOption, type SortOption } from "../components/SortDropdown";
import type { StreamRowData } from "../components/StreamRow";
import { sortStreams } from "./sortStreams";

function makeStream(overrides: Partial<StreamRowData> & { id: string }): StreamRowData {
  return {
    nextAction: "Pause",
    rate: "100 XLM / month",
    recipient: "Default Recipient",
    schedule: "Pays every 30 days",
    status: "active",
    ...overrides,
  };
}

describe("isSortOption", () => {
  it.each<SortOption>([
    "newest",
    "oldest",
    "recipient-asc",
    "recipient-desc",
    "rate-asc",
    "rate-desc",
  ])("accepts valid sort option %s", (option) => {
    expect(isSortOption(option)).toBe(true);
  });

  it("rejects invalid or non-string values", () => {
    expect(isSortOption("")).toBe(false);
    expect(isSortOption("invalid")).toBe(false);
    expect(isSortOption("toString")).toBe(false);
    expect(isSortOption(null)).toBe(false);
    expect(isSortOption(undefined)).toBe(false);
    expect(isSortOption(42)).toBe(false);
  });
});

describe("sortStreams", () => {
  const streams: StreamRowData[] = [
    makeStream({
      id: "s1",
      recipient: "Zara Studio",
      rate: "32 XLM / week",
      startedAt: "2026-01-10T00:00:00Z",
    }),
    makeStream({
      id: "s2",
      recipient: "ada Labs",
      rate: "1,200.50 XLM / month",
      startedAt: "2026-03-15T00:00:00Z",
    }),
    makeStream({
      id: "s3",
      recipient: "Kemi Support",
      rate: "18 XLM / day",
      startedAt: "2026-02-01T00:00:00Z",
    }),
  ];

  it("returns an empty array for an empty list", () => {
    expect(sortStreams([], "newest")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...streams];
    const result = sortStreams(streams, "recipient-asc");
    expect(streams).toEqual(copy);
    expect(result).not.toBe(streams);
  });

  it("sorts by newest first", () => {
    expect(sortStreams(streams, "newest").map((s) => s.id)).toEqual([
      "s2",
      "s3",
      "s1",
    ]);
  });

  it("sorts by oldest first", () => {
    expect(sortStreams(streams, "oldest").map((s) => s.id)).toEqual([
      "s1",
      "s3",
      "s2",
    ]);
  });

  it("sorts by recipient A-Z case-insensitively", () => {
    expect(sortStreams(streams, "recipient-asc").map((s) => s.id)).toEqual([
      "s2",
      "s3",
      "s1",
    ]);
  });

  it("sorts by recipient Z-A case-insensitively", () => {
    expect(sortStreams(streams, "recipient-desc").map((s) => s.id)).toEqual([
      "s1",
      "s3",
      "s2",
    ]);
  });

  it("sorts by rate low-high", () => {
    expect(sortStreams(streams, "rate-asc").map((s) => s.id)).toEqual([
      "s3",
      "s1",
      "s2",
    ]);
  });

  it("sorts by rate high-low", () => {
    expect(sortStreams(streams, "rate-desc").map((s) => s.id)).toEqual([
      "s2",
      "s1",
      "s3",
    ]);
  });

  it("preserves relative order for equal keys (stable sort)", () => {
    const tied: StreamRowData[] = [
      makeStream({
        id: "first",
        recipient: "Same Name",
        rate: "50 XLM / day",
        startedAt: "2026-02-01T00:00:00Z",
      }),
      makeStream({
        id: "second",
        recipient: "Same Name",
        rate: "50 XLM / day",
        startedAt: "2026-02-01T00:00:00Z",
      }),
      makeStream({
        id: "third",
        recipient: "Same Name",
        rate: "50 XLM / day",
        startedAt: "2026-02-01T00:00:00Z",
      }),
    ];

    const allOptions: SortOption[] = [
      "newest",
      "oldest",
      "recipient-asc",
      "recipient-desc",
      "rate-asc",
      "rate-desc",
    ];

    for (const option of allOptions) {
      expect(sortStreams(tied, option).map((s) => s.id)).toEqual([
        "first",
        "second",
        "third",
      ]);
    }
  });

  it("places streams without valid startedAt after dated streams", () => {
    const mixed: StreamRowData[] = [
      makeStream({ id: "undated-1" }),
      makeStream({ id: "older", startedAt: "2026-01-01T00:00:00Z" }),
      makeStream({ id: "newer", startedAt: "2026-05-01T00:00:00Z" }),
      makeStream({ id: "invalid-date", startedAt: "not-a-date" }),
    ];

    expect(sortStreams(mixed, "newest").map((s) => s.id)).toEqual([
      "newer",
      "older",
      "undated-1",
      "invalid-date",
    ]);
    expect(sortStreams(mixed, "oldest").map((s) => s.id)).toEqual([
      "older",
      "newer",
      "undated-1",
      "invalid-date",
    ]);
  });
});
