/**
 * @jest-environment jsdom
 */

import React, { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResetFiltersButton } from "./ResetFiltersButton";

describe("ResetFiltersButton", () => {
  it("renders nothing when isVisible is false", () => {
    const { container } = render(
      <ResetFiltersButton onReset={jest.fn()} isVisible={false} />
    );

    expect(container.firstChild).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reset all filters" })
    ).not.toBeInTheDocument();
  });

  it("renders a focusable button with accessible name 'Reset all filters' by default", () => {
    render(<ResetFiltersButton onReset={jest.fn()} />);

    const button = screen.getByRole("button", { name: "Reset all filters" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveTextContent("Reset filters");

    button.focus();
    expect(button).toHaveFocus();
  });

  it("calls onReset once on mouse click", async () => {
    const user = userEvent.setup();
    const onReset = jest.fn();
    render(<ResetFiltersButton onReset={onReset} />);

    const button = screen.getByRole("button", { name: "Reset all filters" });
    await user.click(button);

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(button).toBeInTheDocument();
  });

  it("calls onReset once on Enter and once on Space", async () => {
    const user = userEvent.setup();
    const onReset = jest.fn();
    render(<ResetFiltersButton onReset={onReset} />);

    const button = screen.getByRole("button", { name: "Reset all filters" });
    button.focus();
    expect(button).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onReset).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it("stays in the DOM until the parent hides it and relies on the parent for focus return", async () => {
    const user = userEvent.setup();

    function FilterWrapper({ moveFocusOnReset }: { moveFocusOnReset: boolean }) {
      const [filter, setFilter] = useState("active");
      const inputRef = useRef<HTMLInputElement>(null);

      const handleReset = () => {
        setFilter("");
        if (moveFocusOnReset) {
          inputRef.current?.focus();
        }
      };

      return (
        <div>
          <input
            ref={inputRef}
            aria-label="Search streams"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ResetFiltersButton
            onReset={handleReset}
            isVisible={filter.length > 0}
          />
        </div>
      );
    }

    // Without parent focus management, removing the focused button falls back to document.body
    const { unmount } = render(<FilterWrapper moveFocusOnReset={false} />);
    const resetButton = screen.getByRole("button", {
      name: "Reset all filters",
    });
    await user.click(resetButton);

    expect(
      screen.queryByRole("button", { name: "Reset all filters" })
    ).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();

    unmount();

    // When the parent moves focus explicitly on reset, focus lands on the parent's target
    render(<FilterWrapper moveFocusOnReset={true} />);
    const resetButton2 = screen.getByRole("button", {
      name: "Reset all filters",
    });
    await user.click(resetButton2);

    expect(
      screen.queryByRole("button", { name: "Reset all filters" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search streams" })).toHaveFocus();
  });
});
