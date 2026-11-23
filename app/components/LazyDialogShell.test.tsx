/**
 * @jest-environment jsdom
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { LazyDialogShell } from "./LazyDialogShell";

expect.extend(toHaveNoViolations);

describe("LazyDialogShell", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("announces the label in a polite status region immediately and hides the dialog before 300ms", () => {
    render(<LazyDialogShell label="Loading shortcuts" />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading shortcuts");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(299);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the modal dialog with aria-label and aria-modal after 300ms", () => {
    render(<LazyDialogShell label="Loading shortcuts" />);

    act(() => {
      jest.advanceTimersByTime(300);
    });

    const dialog = screen.getByRole("dialog", { name: "Loading shortcuts" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("Loading shortcuts");
  });

  it("clears the pending timer on unmount before 300ms without state-update warnings", () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { unmount } = render(<LazyDialogShell label="Loading shortcuts" />);

    act(() => {
      jest.advanceTimersByTime(150);
    });
    unmount();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("handles an empty label without crashing", () => {
    render(<LazyDialogShell label="" />);

    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(300);
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "");
  });

  it("updates the status label and dialog aria-label when label changes after mount", () => {
    const { rerender } = render(<LazyDialogShell label="Loading shortcuts" />);

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(
      screen.getByRole("dialog", { name: "Loading shortcuts" })
    ).toBeInTheDocument();

    rerender(<LazyDialogShell label="Still loading shortcuts" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Still loading shortcuts");
    const dialog = screen.getByRole("dialog", {
      name: "Still loading shortcuts",
    });
    expect(dialog).toHaveTextContent("Still loading shortcuts");
  });

  it("has no accessibility violations in the visible dialog state", async () => {
    const { container } = render(
      <LazyDialogShell label="Loading shortcuts" />
    );

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(
      screen.getByRole("dialog", { name: "Loading shortcuts" })
    ).toBeInTheDocument();

    // axe uses real timers internally
    jest.useRealTimers();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
