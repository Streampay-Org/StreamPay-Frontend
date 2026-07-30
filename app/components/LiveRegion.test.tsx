/** @jest-environment jsdom */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LiveRegion } from "./LiveRegion";

describe("LiveRegion", () => {
  it("renders with role=status and default polite aria-live", () => {
    render(<LiveRegion message="Hello" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("Hello");
  });

  it("applies sr-only class to stay visually hidden", () => {
    render(<LiveRegion message="Hidden text" />);
    const region = screen.getByRole("status");
    expect(region).toHaveClass("sr-only");
  });

  it("defaults to aria-atomic=true", () => {
    render(<LiveRegion message="Test" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-atomic", "true");
  });

  it("renders assertive politeness when specified", () => {
    render(<LiveRegion message="Urgent" politeness="assertive" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "assertive");
  });

  it("renders off politeness when specified", () => {
    render(<LiveRegion message="Silent" politeness="off" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "off");
  });

  it("renders with aria-atomic=false when atomic is false", () => {
    render(<LiveRegion message="Diff only" atomic={false} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-atomic", "false");
  });

  it("renders empty when message is empty string", () => {
    render(<LiveRegion message="" />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
  });

  it("updates text content when message prop changes", () => {
    const { rerender } = render(<LiveRegion message="First" />);
    expect(screen.getByRole("status")).toHaveTextContent("First");

    rerender(<LiveRegion message="Second" />);
    expect(screen.getByRole("status")).toHaveTextContent("Second");
  });

  it("forwards data-testid when provided", () => {
    render(<LiveRegion message="Test" data-testid="my-region" />);
    expect(screen.getByTestId("my-region")).toBeInTheDocument();
  });
});
