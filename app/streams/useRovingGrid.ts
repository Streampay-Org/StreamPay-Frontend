"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type GridCell = { rowIndex: number; columnIndex: number };

export type RovingGridOptions = {
  rowIds: string[];
  columnCount: number;
  pageSize?: number;
  direction?: "ltr" | "rtl";
};

export type RovingGridCellProps = {
  role: "gridcell";
  tabIndex: 0 | -1;
  "data-grid-cell": string;
  onFocus: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  ref?: (element: HTMLElement | null) => void;
};

/**
 * Keeps a dynamic ARIA grid on one tab stop while exposing predictable,
 * spreadsheet-style keyboard movement for its cells.
 */
export function useRovingGrid({
  rowIds,
  columnCount,
  pageSize = 5,
  direction = "ltr",
}: RovingGridOptions) {
  const [activeCell, setActiveCell] = useState<GridCell>({
    rowIndex: 0,
    columnIndex: 0,
  });
  const cellRefs = useRef(new Map<string, HTMLElement>());
  const lastRowIndex = Math.max(0, rowIds.length - 1);
  const safeColumnCount = Math.max(1, columnCount);

  useEffect(() => {
    setActiveCell((current) => ({
      rowIndex: Math.min(current.rowIndex, lastRowIndex),
      columnIndex: Math.min(current.columnIndex, safeColumnCount - 1),
    }));
  }, [lastRowIndex, safeColumnCount]);

  const focusCell = useCallback((next: GridCell) => {
    const key = `${next.rowIndex}:${next.columnIndex}`;
    cellRefs.current.get(key)?.focus();
  }, []);

  const moveTo = useCallback(
    (rowIndex: number, columnIndex: number) => {
      if (rowIds.length === 0) return;
      const next = {
        rowIndex: Math.max(0, Math.min(rowIndex, lastRowIndex)),
        columnIndex: Math.max(0, Math.min(columnIndex, safeColumnCount - 1)),
      };
      setActiveCell(next);
      focusCell(next);
    },
    [focusCell, lastRowIndex, rowIds.length, safeColumnCount],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, cell: GridCell) => {
      const isControl =
        event.target instanceof HTMLElement &&
        (event.target.matches("button, a, input, select, textarea, [role=menu]") ||
          event.target !== event.currentTarget);
      if (event.key === "Enter" || event.key === " ") {
        if (isControl) return;
        const firstAction = event.currentTarget.querySelector<HTMLElement>(
          "button:not([disabled]), a, input, select, textarea",
        );
        if (firstAction) {
          event.preventDefault();
          firstAction.click();
        }
        return;
      }

      let next: GridCell | null = null;
      const horizontalStep = direction === "rtl" ? -1 : 1;
      switch (event.key) {
        case "ArrowUp":
          next = { rowIndex: cell.rowIndex - 1, columnIndex: cell.columnIndex };
          break;
        case "ArrowDown":
          next = { rowIndex: cell.rowIndex + 1, columnIndex: cell.columnIndex };
          break;
        case "ArrowLeft":
          next = { rowIndex: cell.rowIndex, columnIndex: cell.columnIndex - horizontalStep };
          break;
        case "ArrowRight":
          next = { rowIndex: cell.rowIndex, columnIndex: cell.columnIndex + horizontalStep };
          break;
        case "Home":
          next = event.ctrlKey
            ? { rowIndex: 0, columnIndex: 0 }
            : { rowIndex: cell.rowIndex, columnIndex: 0 };
          break;
        case "End":
          next = event.ctrlKey
            ? { rowIndex: lastRowIndex, columnIndex: safeColumnCount - 1 }
            : { rowIndex: cell.rowIndex, columnIndex: safeColumnCount - 1 };
          break;
        case "PageUp":
          next = { rowIndex: cell.rowIndex - pageSize, columnIndex: cell.columnIndex };
          break;
        case "PageDown":
          next = { rowIndex: cell.rowIndex + pageSize, columnIndex: cell.columnIndex };
          break;
      }

      if (!next) return;
      event.preventDefault();
      moveTo(next.rowIndex, next.columnIndex);
    },
    [direction, lastRowIndex, moveTo, pageSize, safeColumnCount],
  );

  const registerCell = useCallback(
    (rowIndex: number, columnIndex: number, element: HTMLElement | null) => {
      const key = `${rowIndex}:${columnIndex}`;
      if (element) cellRefs.current.set(key, element);
      else cellRefs.current.delete(key);
    },
    [],
  );

  const getCellProps = useCallback(
    (rowIndex: number, columnIndex: number): RovingGridCellProps => ({
      role: "gridcell",
      tabIndex:
        activeCell.rowIndex === rowIndex && activeCell.columnIndex === columnIndex
          ? 0
          : -1,
      "data-grid-cell": `${rowIds[rowIndex] ?? rowIndex}:${columnIndex}`,
      onFocus: () => setActiveCell({ rowIndex, columnIndex }),
      onKeyDown: (event) => handleKeyDown(event, { rowIndex, columnIndex }),
    }),
    [activeCell, handleKeyDown, rowIds],
  );

  const gridProps = useMemo(
    () => ({
      role: "grid" as const,
      "aria-rowcount": rowIds.length + 1,
      "aria-colcount": safeColumnCount,
    }),
    [rowIds.length, safeColumnCount],
  );

  return { activeCell, gridProps, getCellProps, registerCell };
}
