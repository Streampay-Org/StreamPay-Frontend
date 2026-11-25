/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { StreamsPageContent } from "./StreamsPageContent";
import { mockStreams } from "./fixtures";

jest.mock("../components/StreamRow", () => ({
  StreamRow: ({ stream }: { stream: { recipient: string } }) => (
    <div data-testid="stream-row">{stream.recipient}</div>
  ),
}));

type RouterMock = ReturnType<typeof useRouter>;

function params(query: string) {
  return new URLSearchParams(query) as unknown as ReturnType<
    typeof useSearchParams
  >;
}

function renderedRecipients(): string[] {
  return screen.getAllByTestId("stream-row").map((row) => row.textContent ?? "");
}

describe("StreamsPageContent URL query state", () => {
  const replace = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    jest.mocked(useRouter).mockReturnValue({
      replace,
    } as unknown as RouterMock);
    jest.mocked(usePathname).mockReturnValue("/streams");
    jest.mocked(useSearchParams).mockReturnValue(params(""));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("restores tag, status, search, and sort from the URL", () => {
    jest
      .mocked(useSearchParams)
      .mockReturnValue(params("tag=vendor&status=active&q=ada&sort=oldest"));

    render(<StreamsPageContent streams={mockStreams} />);

    expect(renderedRecipients()).toEqual(["Ada Creative Studio"]);
    expect(screen.getByLabelText("Search streams")).toHaveValue("ada");
    expect(screen.getByLabelText("Filter by status")).toHaveValue("active");
    expect(screen.getByRole("button", { name: "vendor" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Sort streams")).toHaveValue("oldest");
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores an unknown tag and shows the unfiltered list", () => {
    jest.mocked(useSearchParams).mockReturnValue(params("tag=retired-team"));

    render(<StreamsPageContent streams={mockStreams} />);

    expect(renderedRecipients()).toHaveLength(mockStreams.length);
    expect(screen.queryByRole("button", { name: "Clear tag filter" })).not.toBeInTheDocument();
  });

  it("writes status and tag changes, and resets all filters", () => {
    jest.mocked(useSearchParams).mockReturnValue(params("tag=vendor"));

    render(<StreamsPageContent streams={mockStreams} />);

    fireEvent.change(screen.getByLabelText("Filter by status"), {
      target: { value: "ended" },
    });
    expect(replace).toHaveBeenLastCalledWith(
      "/streams?tag=vendor&status=ended",
      { scroll: false },
    );
    expect(renderedRecipients()).toEqual(["Yusuf QA Partnership"]);

    fireEvent.click(screen.getByRole("button", { name: "Reset all filters" }));
    expect(replace).toHaveBeenLastCalledWith("/streams", { scroll: false });
  });

  it("debounces search input into the URL", () => {
    jest.useFakeTimers();
    render(<StreamsPageContent streams={mockStreams} />);

    fireEvent.change(screen.getByLabelText("Search streams"), {
      target: { value: "kemi" },
    });

    expect(renderedRecipients()).toEqual(["Kemi Onboarding Support"]);
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(replace).toHaveBeenCalledWith("/streams?q=kemi", { scroll: false });
  });

  it("shows the filtered-empty state with a working clear action", () => {
    const onClearFilters = jest.fn();
    jest.mocked(useSearchParams).mockReturnValue(params("q=zzz"));

    render(
      <StreamsPageContent
        streams={mockStreams}
        onClearFilters={onClearFilters}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "No streams match your current filters",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(replace).toHaveBeenLastCalledWith("/streams", { scroll: false });
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
