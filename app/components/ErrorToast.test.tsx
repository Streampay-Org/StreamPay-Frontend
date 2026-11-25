import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorToast } from "./ErrorToast";
import type { StreamPayError } from "../lib/errors/types";

function makeError(overrides: Partial<StreamPayError> = {}): StreamPayError {
  return {
    type: "about:blank",
    code: "INTERNAL_ERROR",
    title: "Something went wrong",
    detail: "Please try again in a moment.",
    status: 500,
    category: "server",
    retry: { retryable: false },
    ...overrides,
  };
}

describe("ErrorToast", () => {
  it("renders the formatted error and an auto-dismiss progress bar", () => {
    render(<ErrorToast error={makeError()} onDismiss={jest.fn()} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("Please try again in a moment.")).toBeInTheDocument();
    expect(screen.getByTestId("error-toast-progress")).toBeInTheDocument();
  });

  it("dismisses when the CSS countdown animation ends", () => {
    const onDismiss = jest.fn();
    render(<ErrorToast error={makeError()} onDismiss={onDismiss} />);

    fireEvent.animationEnd(screen.getByTestId("error-toast-progress"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not auto-dismiss or render a progress bar when autoDismiss is false", () => {
    const onDismiss = jest.fn();
    render(
      <ErrorToast error={makeError()} onDismiss={onDismiss} autoDismiss={false} />,
    );

    expect(screen.queryByTestId("error-toast-progress")).not.toBeInTheDocument();

    fireEvent.animationEnd(screen.getByTestId("error-toast"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("applies the configured delay to the CSS animation", () => {
    render(
      <ErrorToast
        error={makeError()}
        onDismiss={jest.fn()}
        autoDismissDelayMs={8000}
      />,
    );

    expect(screen.getByTestId("error-toast-progress")).toHaveStyle({
      animationDuration: "8000ms",
    });
  });

  it("pauses the countdown on hover and resumes on leave", () => {
    render(<ErrorToast error={makeError()} onDismiss={jest.fn()} />);
    const toast = screen.getByTestId("error-toast");
    const bar = screen.getByTestId("error-toast-progress");

    expect(bar).toHaveStyle({ animationPlayState: "running" });

    fireEvent.mouseEnter(toast);
    expect(screen.getByTestId("error-toast-progress")).toHaveStyle({
      animationPlayState: "paused",
    });

    fireEvent.mouseLeave(toast);
    expect(screen.getByTestId("error-toast-progress")).toHaveStyle({
      animationPlayState: "running",
    });
  });

  it("keeps the countdown paused while focus is inside the toast", () => {
    render(
      <ErrorToast
        error={makeError()}
        onDismiss={jest.fn()}
        onRetry={jest.fn()}
      />,
    );
    const toast = screen.getByTestId("error-toast");
    const retry = screen.getByRole("button", { name: "Retry" });

    fireEvent.focus(retry);
    expect(screen.getByTestId("error-toast-progress")).toHaveStyle({
      animationPlayState: "paused",
    });

    fireEvent.blur(retry, { relatedTarget: document.body });
    expect(screen.getByTestId("error-toast-progress")).toHaveStyle({
      animationPlayState: "running",
    });

    // The root remains keyboard-focusable through its controls.
    expect(toast).toContainElement(retry);
  });

  it("retries and dismisses through the existing controls", () => {
    const onDismiss = jest.fn();
    const onRetry = jest.fn();
    render(
      <ErrorToast
        error={makeError({ code: "NETWORK_TIMEOUT", retry: { retryable: true } })}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
