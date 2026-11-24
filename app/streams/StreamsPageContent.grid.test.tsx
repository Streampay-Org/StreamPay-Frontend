/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StreamsPageContent } from "./StreamsPageContent";
import { mockStreams } from "./fixtures";

jest.mock("../../lib/apiClient", () => ({
  fetchWithIdempotency: jest.fn().mockResolvedValue({ ok: true }),
}));

describe("StreamsPageContent ARIA grid", () => {
  it("renders a labelled grid with headers, rows, cells, and one tab stop", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} initialSort="newest" />);

    const grid = screen.getByRole("grid", { name: "Streams list" });
    expect(grid).toHaveAttribute("aria-rowcount", "4");
    expect(screen.getAllByRole("columnheader")).toHaveLength(4);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getAllByRole("gridcell")).toHaveLength(12);
    expect(grid.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
    expect(grid.querySelectorAll("button:not([tabindex='-1'])")).toHaveLength(0);
  });

  it("moves the roving focus cell between rows without adding tab stops", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams.slice(0, 2)} />);
    const cells = screen.getAllByRole("gridcell");
    act(() => cells[0]?.focus());
    act(() => fireEvent.keyDown(cells[0]!, { key: "ArrowDown" }));

    expect(cells[4]).toHaveFocus();
    expect(document.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  });

  it("keeps loading placeholders out of the interactive grid", () => {
    render(<StreamsPageContent state="loading" streams={[]} />);
    expect(screen.getByRole("status", { name: "Loading streams" })).toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-testid=stream-row-skeleton][aria-hidden=true]")).toHaveLength(3);
    expect(document.querySelector(".stream-list[aria-hidden=true]")).toBeInTheDocument();
  });

  it("offers the row action menu and keeps cancellation disabled for terminal streams", () => {
    render(
      <StreamsPageContent
        state="populated"
        streams={[{ ...mockStreams[2]!, status: "ended", nextAction: "Withdraw" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Withdraw actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Withdraw" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cancel stream" })).toBeDisabled();
  });
});
