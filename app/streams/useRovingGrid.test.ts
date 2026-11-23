/** @jest-environment jsdom */

import React from "react";
import { act, fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useRovingGrid } from "./useRovingGrid";

function TestGrid({ direction = "ltr" }: { direction?: "ltr" | "rtl" }) {
  const rowIds = ["one", "two", "three"];
  const { getCellProps, registerCell } = useRovingGrid({
    rowIds,
    columnCount: 3,
    pageSize: 2,
    direction,
  });

  return React.createElement(
    "div",
    { role: "grid" },
    rowIds.map((rowId, rowIndex) =>
      React.createElement(
        "div",
        { role: "row", key: rowId },
        [0, 1, 2].map((columnIndex) =>
          React.createElement(
            "div",
            {
              key: columnIndex,
              "data-testid": `${rowId}-${columnIndex}`,
              ...getCellProps(rowIndex, columnIndex),
              ref: (element: HTMLElement | null) =>
                registerCell(rowIndex, columnIndex, element),
            },
            `${rowId} column ${columnIndex + 1}`,
          ),
        ),
      ),
    ),
  );
}

describe("useRovingGrid", () => {
  it("exposes one tab stop and moves vertically, horizontally, and by page", () => {
    const { getByTestId } = render(React.createElement(TestGrid));
    const first = getByTestId("one-0");
    act(() => first.focus());

    expect(document.querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
    expect(first).toHaveFocus();

    act(() => fireEvent.keyDown(first, { key: "ArrowDown" }));
    expect(getByTestId("two-0")).toHaveFocus();

    act(() => fireEvent.keyDown(getByTestId("two-0"), { key: "ArrowRight" }));
    expect(getByTestId("two-1")).toHaveFocus();

    act(() => fireEvent.keyDown(getByTestId("two-1"), { key: "PageDown" }));
    expect(getByTestId("three-1")).toHaveFocus();
  });

  it("supports Home/End bounds and reverses horizontal movement for RTL", () => {
    const { getByTestId } = render(React.createElement(TestGrid, { direction: "rtl" }));
    const middle = getByTestId("two-1");
    act(() => middle.focus());

    act(() => fireEvent.keyDown(middle, { key: "ArrowRight" }));
    expect(getByTestId("two-0")).toHaveFocus();

    act(() => fireEvent.keyDown(getByTestId("two-0"), { key: "Home" }));
    expect(getByTestId("two-0")).toHaveFocus();

    act(() => fireEvent.keyDown(getByTestId("two-0"), { key: "End", ctrlKey: true }));
    expect(getByTestId("three-2")).toHaveFocus();
  });

  it("clamps the active cell when rows are removed", () => {
    function ShrinkingGrid() {
      const [rows, setRows] = React.useState(["one", "two"]);
      const grid = useRovingGrid({ rowIds: rows, columnCount: 1 });
      return React.createElement(
        "div",
        { role: "grid" },
        React.createElement(
          "button",
          { type: "button", onClick: () => setRows(["one"]) },
          "Remove row",
        ),
        rows.map((rowId, rowIndex) =>
          React.createElement(
            "div",
            { key: rowId, "data-testid": rowId, ...grid.getCellProps(rowIndex, 0), ref: (element: HTMLElement | null) => grid.registerCell(rowIndex, 0, element) },
            rowId,
          ),
        ),
      );
    }

    const { getByRole, getByTestId } = render(React.createElement(ShrinkingGrid));
    act(() => getByTestId("two").focus());
    act(() => fireEvent.click(getByRole("button", { name: "Remove row" })));
    expect(getByTestId("one")).toHaveAttribute("tabindex", "0");
  });
});
