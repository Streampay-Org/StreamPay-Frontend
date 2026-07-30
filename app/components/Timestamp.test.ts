/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { Timestamp } from "./Timestamp";

describe("Timestamp", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-27T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows relative time by default and reveals exact values on hover", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    expect(screen.getByText("2 hours ago")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("button", { name: /show exact timestamp/i }));

    expect(screen.getByRole("tooltip")).toHaveTextContent("Relative: 2 hours ago");
    expect(screen.getByRole("tooltip")).toHaveTextContent("ISO: 2026-06-27T10:00:00.000Z");
  });

  it("supports long-press on touch devices", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });
    act(() => {
      fireEvent.pointerDown(trigger);
      jest.advanceTimersByTime(500);
    });

    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  // ── Regression: #551 – duplicate tooltip on hover ──────────────────────────
  //
  // Previously the button had a `title` attribute whose value duplicated the
  // custom .timestamp__tooltip content. Browsers render the native title as a
  // second overlay, so on hover the user saw two tooltips simultaneously.
  //
  // The fix removes the `title` attribute entirely. The custom tooltip already
  // exposes all three data points (relative, absolute, ISO) via the ARIA
  // role="tooltip" element, satisfying both UX and accessibility requirements.

  it("does not have a native title attribute on the trigger button (regression #551)", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });

    // The native `title` attribute must be absent so the browser does not
    // render a second tooltip alongside the custom one.
    expect(trigger).not.toHaveAttribute("title");
  });

  it("shows exactly one tooltip element on hover (regression #551)", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });
    fireEvent.mouseEnter(trigger);

    // Only a single element with role="tooltip" should be present.
    const tooltips = screen.getAllByRole("tooltip");
    expect(tooltips).toHaveLength(1);
  });

  it("tooltip contains relative time, absolute time, and ISO string (regression #551)", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    fireEvent.mouseEnter(screen.getByRole("button", { name: /show exact timestamp/i }));

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Relative:");
    expect(tooltip).toHaveTextContent("Absolute:");
    expect(tooltip).toHaveTextContent("ISO: 2026-06-27T10:00:00.000Z");
  });

  it("hides the tooltip on mouse leave", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the tooltip on keyboard focus and hides it on blur", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.blur(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("cancels long-press and hides tooltip when pointer leaves before threshold", () => {
    render(React.createElement(Timestamp, { iso: "2026-06-27T10:00:00.000Z" }));

    const trigger = screen.getByRole("button", { name: /show exact timestamp/i });
    act(() => {
      fireEvent.pointerDown(trigger);
      jest.advanceTimersByTime(200); // less than LONG_PRESS_DELAY_MS (450)
      fireEvent.pointerLeave(trigger);
    });

    // Timer was cancelled; no tooltip should appear.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
