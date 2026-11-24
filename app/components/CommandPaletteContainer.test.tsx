/**
 * @jest-environment jsdom
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import CommandPaletteContainer from "./CommandPaletteContainer";
import { mockStreams as mockFallbackStreams } from "../streams/fixtures";
import type { StreamRowData } from "./StreamRow";

const mockPaletteProps = jest.fn();

jest.mock("./CommandPalette", () => ({
  CommandPalette: (props: {
    streams: StreamRowData[];
    defaultOpen?: boolean;
  }) => {
    mockPaletteProps(props);
    return <div data-testid="palette" />;
  },
}));

jest.mock("../streams/fixtures", () => ({
  mockStreams: [
    {
      id: "stream-ada",
      nextAction: "Pause",
      rate: "120 XLM / month",
      recipient: "Ada Creative Studio",
      schedule: "Pays every 30 days",
      status: "active",
    },
  ],
}));

function lastPaletteProps(): { streams: StreamRowData[]; defaultOpen?: boolean } {
  const calls = mockPaletteProps.mock.calls;
  return calls[calls.length - 1][0];
}

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  };
}

/**
 * The container caches streams at module scope for 30s. Moving the clock past
 * the TTL before each test makes any cache left by a previous test stale, so
 * every test starts from an empty cache.
 */
let fakeNow = 1_000_000;

beforeEach(() => {
  mockPaletteProps.mockClear();
  fakeNow += 60_000;
  jest.spyOn(Date, "now").mockImplementation(() => fakeNow);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe("CommandPaletteContainer", () => {
  it("fetches streams, maps rows, and mounts the palette open", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      okResponse([
        {
          id: "s1",
          recipient: "Ada",
          rate: "1 XLM / day",
          schedule: "daily",
          status: "active",
          nextAction: "Pause",
        },
        { id: "s2" },
      ])
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CommandPaletteContainer />);

    await waitFor(() => expect(lastPaletteProps().streams).toHaveLength(2));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/streams?limit=50",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(lastPaletteProps().defaultOpen).toBe(true);
    expect(lastPaletteProps().streams[0]).toEqual({
      id: "s1",
      recipient: "Ada",
      rate: "1 XLM / day",
      schedule: "daily",
      status: "active",
      nextAction: "Pause",
    });
    expect(lastPaletteProps().streams[1]).toEqual({
      id: "s2",
      recipient: "",
      rate: "",
      schedule: "",
      status: "draft",
      nextAction: "",
    });
  });

  it("falls back to the demo fixture on a non-OK response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "unavailable" }),
    }) as unknown as typeof fetch;

    render(<CommandPaletteContainer />);

    await waitFor(() =>
      expect(lastPaletteProps().streams).toEqual(mockFallbackStreams)
    );
    expect(lastPaletteProps().defaultOpen).toBe(true);
  });

  it("falls back to the demo fixture on a network error", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    render(<CommandPaletteContainer />);

    await waitFor(() =>
      expect(lastPaletteProps().streams).toEqual(mockFallbackStreams)
    );
  });

  it("renders no rows when the payload has no data array", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CommandPaletteContainer />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastPaletteProps().streams).toEqual([]));
  });

  it("aborts the request and ignores the result after unmount", async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = render(<CommandPaletteContainer />);

    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);

    resolveFetch(okResponse([{ id: "late", recipient: "Late" }]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      mockPaletteProps.mock.calls.every(
        ([props]) => (props as { streams: StreamRowData[] }).streams.length === 0
      )
    ).toBe(true);
  });

  it("caches streams for 30s and refetches once the TTL expires", async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse([{ id: "s1" }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = render(<CommandPaletteContainer />);
    await waitFor(() => expect(lastPaletteProps().streams).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    fakeNow += 29_000;
    const second = render(<CommandPaletteContainer />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastPaletteProps().streams).toEqual([
      {
        id: "s1",
        recipient: "",
        rate: "",
        schedule: "",
        status: "draft",
        nextAction: "",
      },
    ]);
    second.unmount();

    fakeNow += 1_001;
    render(<CommandPaletteContainer />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
