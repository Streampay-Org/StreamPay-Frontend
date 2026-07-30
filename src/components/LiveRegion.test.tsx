/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LiveRegion } from "./LiveRegion";

describe("LiveRegion", () => {
  // ── Default behaviour ────────────────────────────────────────────────────

  it("renders a visually-hidden element with role=status by default", () => {
    render(<LiveRegion message="Hello" />);
    const region = screen.getByRole("status");
    expect(region).toBeInTheDocument();
  });

  it("renders the message text", () => {
    render(<LiveRegion message="Stream created." />);
    expect(screen.getByRole("status")).toHaveTextContent("Stream created.");
  });

  it("applies .sr-only class so it is visually hidden but AT-accessible", () => {
    render(<LiveRegion message="Hidden text" />);
    expect(screen.getByRole("status")).toHaveClass("sr-only");
  });

  it("defaults to aria-live=polite", () => {
    render(<LiveRegion message="Test" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("defaults to aria-atomic=true", () => {
    render(<LiveRegion message="Test" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  });

  // ── Politeness levels ────────────────────────────────────────────────────

  it("renders role=alert and aria-live=assertive when politeness=assertive", () => {
    render(<LiveRegion message="Critical error" politeness="assertive" />);
    // assertive → role=alert (WCAG technique ARIA19)
    const region = screen.getByRole("alert");
    expect(region).toHaveAttribute("aria-live", "assertive");
  });

  it("renders role=status and aria-live=off when politeness=off", () => {
    render(<LiveRegion message="Silent" politeness="off" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "off");
  });

  it("renders role=status and aria-live=polite explicitly", () => {
    render(<LiveRegion message="Update" politeness="polite" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  // ── atomic prop ──────────────────────────────────────────────────────────

  it("sets aria-atomic=false when atomic=false", () => {
    render(<LiveRegion message="Partial diff" atomic={false} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "false");
  });

  it("sets aria-atomic=true explicitly", () => {
    render(<LiveRegion message="Full read" atomic={true} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("renders empty when message is empty string (silences the region)", () => {
    render(<LiveRegion message="" />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("updates text content when message prop changes", () => {
    const { rerender } = render(<LiveRegion message="First" />);
    expect(screen.getByRole("status")).toHaveTextContent("First");

    rerender(<LiveRegion message="Second" />);
    expect(screen.getByRole("status")).toHaveTextContent("Second");
  });

  it("handles repeated identical messages without error", () => {
    const { rerender } = render(<LiveRegion message="Same" />);
    rerender(<LiveRegion message="Same" />);
    expect(screen.getByRole("status")).toHaveTextContent("Same");
  });

  it("handles very long messages without layout impact (sr-only)", () => {
    const longMsg = "A".repeat(500);
    render(<LiveRegion message={longMsg} />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(longMsg);
    expect(region).toHaveClass("sr-only");
  });

  // ── data-testid forwarding ───────────────────────────────────────────────

  it("forwards data-testid when provided", () => {
    render(<LiveRegion message="Test" data-testid="my-region" />);
    expect(screen.getByTestId("my-region")).toBeInTheDocument();
  });

  it("renders without data-testid when not provided", () => {
    render(<LiveRegion message="Test" />);
    // Should still render role=status even without testid
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // ── CreateStreamForm integration scenarios ───────────────────────────────

  it("handles all CreateStreamForm announcement messages", () => {
    const messages = [
      "Loading stream creation form…",
      "Creating stream, please wait…",
      "Stream created successfully.",
      "Stream creation failed: Network error",
      "Stream creation cancelled.",
    ];

    const { rerender } = render(<LiveRegion message={messages[0]} />);

    messages.forEach((msg) => {
      rerender(<LiveRegion message={msg} />);
      expect(screen.getByRole("status")).toHaveTextContent(msg);
    });
  });
});
