/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { KbdHint } from "./KbdHint";

describe("KbdHint", () => {
  it("renders a single key as a <kbd> element", () => {
    const { container } = render(<KbdHint keys={["Esc"]} label="Close" />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds).toHaveLength(1);
    expect(kbds[0].tagName.toLowerCase()).toBe("kbd");
    expect(kbds[0]).toHaveTextContent("Esc");
  });

  it("renders multiple keys as separate <kbd> elements with '+' separators", () => {
    const { container } = render(<KbdHint keys={["Ctrl", "Enter"]} label="Submit" />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds).toHaveLength(2);
    expect(kbds[0]).toHaveTextContent("Ctrl");
    expect(kbds[1]).toHaveTextContent("Enter");
    // Separator is present
    expect(screen.getByTestId("kbd-hint").textContent).toContain("+");
  });

  it("sets aria-label on the wrapper span when not aria-hidden", () => {
    render(<KbdHint keys={["Ctrl", "K"]} label="Command palette" />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).toHaveAttribute("aria-label", "Keyboard shortcut: Ctrl K");
  });

  it("sets aria-hidden='true' when aria-hidden prop is passed", () => {
    render(<KbdHint keys={["Alt", "R"]} label="Focus recipient" aria-hidden />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(wrapper).not.toHaveAttribute("aria-label");
  });

  it("does not render aria-hidden on the wrapper when aria-hidden is false/absent", () => {
    render(<KbdHint keys={["Esc"]} label="Close" />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).not.toHaveAttribute("aria-hidden");
  });

  it("applies title attribute with the label prop", () => {
    render(<KbdHint keys={["Ctrl", "↵"]} label="Submit form" />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).toHaveAttribute("title", "Submit form");
  });

  it("applies custom className to the wrapper", () => {
    render(<KbdHint keys={["Esc"]} label="Close" className="my-hint" />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).toHaveClass("my-hint");
  });

  it("renders three keys with two separators", () => {
    const { container } = render(<KbdHint keys={["Ctrl", "Shift", "P"]} label="Command" />);
    const kbds = container.querySelectorAll("kbd");
    expect(kbds).toHaveLength(3);
    const text = screen.getByTestId("kbd-hint").textContent ?? "";
    // Two '+' separators
    const plusCount = (text.match(/\+/g) ?? []).length;
    expect(plusCount).toBe(2);
  });

  it("renders an empty keys array without throwing", () => {
    // Edge case: no keys
    const { container } = render(<KbdHint keys={[]} label="No keys" />);
    const wrapper = screen.getByTestId("kbd-hint");
    expect(wrapper).toBeInTheDocument();
    expect(container.querySelectorAll("kbd")).toHaveLength(0);
  });

  it("uses data-testid for test selection", () => {
    render(<KbdHint keys={["F1"]} label="Help" />);
    expect(screen.getByTestId("kbd-hint")).toBeInTheDocument();
  });
});
