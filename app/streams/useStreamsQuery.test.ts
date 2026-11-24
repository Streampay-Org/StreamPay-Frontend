import { act, renderHook } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DEFAULT_STREAMS_QUERY,
  parseStreamsQuery,
  serialiseStreamsQuery,
  useStreamsQuery,
} from "./useStreamsQuery";

type RouterMock = ReturnType<typeof useRouter>;

function params(query: string) {
  return new URLSearchParams(query) as unknown as ReturnType<
    typeof useSearchParams
  >;
}

describe("parseStreamsQuery", () => {
  it("reads every supported param", () => {
    expect(
      parseStreamsQuery(new URLSearchParams("tag=vendor&status=active&q=ada&sort=oldest")),
    ).toEqual({
      tag: "vendor",
      status: "active",
      q: "ada",
      sort: "oldest",
    });
  });

  it("trims values and treats whitespace-only values as absent", () => {
    expect(
      parseStreamsQuery(
        new URLSearchParams("tag=%20vendor%20&status=%20active%20&q=%20ada%20&sort=%20oldest%20"),
      ),
    ).toEqual({ tag: "vendor", status: "active", q: "ada", sort: "oldest" });

    expect(parseStreamsQuery(new URLSearchParams("tag=%20%20&q=%20%20"))).toEqual(
      DEFAULT_STREAMS_QUERY,
    );
  });

  it("ignores unknown statuses and invalid sort values", () => {
    const parsed = parseStreamsQuery(
      new URLSearchParams("status=deleted&sort=random&tag=vendor"),
    );

    expect(parsed.status).toBeNull();
    expect(parsed.sort).toBe("newest");
    expect(parsed.tag).toBe("vendor");
  });

  it("uses the first value when a param is repeated", () => {
    expect(parseStreamsQuery(new URLSearchParams("tag=alpha&tag=beta")).tag).toBe(
      "alpha",
    );
  });

  it("decodes percent-encoded tag values", () => {
    expect(
      parseStreamsQuery(new URLSearchParams(`tag=${encodeURIComponent("R&D")}`)).tag,
    ).toBe("R&D");
  });
});

describe("serialiseStreamsQuery", () => {
  it("serialises only non-default values", () => {
    expect(
      serialiseStreamsQuery({
        tag: "R&D",
        status: "active",
        q: "ada",
        sort: "oldest",
      }),
    ).toBe("tag=R%26D&status=active&q=ada&sort=oldest");

    expect(serialiseStreamsQuery(DEFAULT_STREAMS_QUERY)).toBe("");
    expect(
      serialiseStreamsQuery({ ...DEFAULT_STREAMS_QUERY, tag: "   ", q: "  " }),
    ).toBe("");
  });

  it("round-trips through the parser", () => {
    const query = { tag: "vendor", status: "paused", q: "ada", sort: "rate-asc" } as const;

    expect(parseStreamsQuery(new URLSearchParams(serialiseStreamsQuery(query)))).toEqual(
      query,
    );
  });
});

describe("useStreamsQuery", () => {
  const replace = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as RouterMock);
    jest.mocked(usePathname).mockReturnValue("/streams");
    jest.mocked(useSearchParams).mockReturnValue(params(""));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports the parsed URL state", () => {
    jest.mocked(useSearchParams).mockReturnValue(params("tag=vendor&status=active&q=ada&sort=oldest"));

    const { result } = renderHook(() => useStreamsQuery());

    expect(result.current.tag).toBe("vendor");
    expect(result.current.status).toBe("active");
    expect(result.current.q).toBe("ada");
    expect(result.current.sort).toBe("oldest");
    expect(result.current.hasSortParam).toBe(true);
    expect(result.current.searchValue).toBe("ada");
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores an invalid tag parameter so the list stays unfiltered", () => {
    jest.mocked(useSearchParams).mockReturnValue(params("tag=missing&status=deleted"));

    const { result } = renderHook(() => useStreamsQuery());

    expect(result.current.tag).toBe("missing");
    expect(result.current.status).toBeNull();
    expect(result.current.hasSortParam).toBe(false);
  });

  it("writes tag and status changes with router.replace and no scroll", () => {
    jest.mocked(useSearchParams).mockReturnValue(params("status=active"));

    const { result } = renderHook(() => useStreamsQuery());

    act(() => result.current.setTag("vendor"));
    expect(replace).toHaveBeenLastCalledWith("/streams?tag=vendor&status=active", {
      scroll: false,
    });

    act(() => result.current.setStatus("draft"));
    expect(replace).toHaveBeenLastCalledWith("/streams?tag=vendor&status=draft", {
      scroll: false,
    });

    act(() => result.current.setStatus(null));
    expect(replace).toHaveBeenLastCalledWith("/streams?tag=vendor", {
      scroll: false,
    });
  });

  it("mirrors sort changes into the URL", () => {
    const { result } = renderHook(() => useStreamsQuery());

    act(() => result.current.setSort("rate-asc"));

    expect(replace).toHaveBeenLastCalledWith("/streams?sort=rate-asc", {
      scroll: false,
    });
  });

  it("debounces search writes and drops empty values", () => {
    jest.useFakeTimers();
    const { result } = renderHook(() => useStreamsQuery({ searchDebounceMs: 300 }));

    act(() => result.current.setSearch("  ada  "));
    expect(result.current.searchValue).toBe("  ada  ");

    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(replace).toHaveBeenCalledWith("/streams?q=ada", { scroll: false });
  });

  it("removes the query param when the search is cleared", () => {
    jest.useFakeTimers();
    jest.mocked(useSearchParams).mockReturnValue(params("q=ada"));

    const { result } = renderHook(() => useStreamsQuery({ searchDebounceMs: 300 }));

    act(() => result.current.setSearch("   "));
    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(replace).toHaveBeenCalledWith("/streams", { scroll: false });
  });

  it("clears filters while preserving the sort preference", () => {
    jest.mocked(useSearchParams).mockReturnValue(
      params("tag=vendor&status=active&q=ada&sort=oldest"),
    );

    const { result } = renderHook(() => useStreamsQuery());

    act(() => result.current.clearFilters());

    expect(result.current.searchValue).toBe("");
    expect(replace).toHaveBeenCalledWith("/streams?sort=oldest", { scroll: false });
  });
});
