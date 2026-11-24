/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

// Mock console.error to avoid noise in test output
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});

afterAll(() => {
  console.error = originalConsoleError;
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div data-testid="child-content">Child content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("catches errors in child components and displays fallback UI", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /something went wrong/i }),
    ).toBeInTheDocument();
  });

  it("calls onError callback when an error is caught", () => {
    const onError = jest.fn();
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary onError={onError}>
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        componentStack: expect.any(String),
      }),
    );
  });

  it("renders custom fallback when provided", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };
    const customFallback = <div data-testid="custom-fallback">Custom error</div>;

    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId("custom-fallback")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses custom error heading when provided", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary errorHeading="Custom error heading">
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(
      screen.getByRole("heading", { name: /custom error heading/i }),
    ).toBeInTheDocument();
  });

  it("uses custom error message when provided", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary errorMessage="Custom error message">
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/custom error message/i)).toBeInTheDocument();
  });

  it("uses custom retry label when provided", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary retryLabel="Reload page">
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("button", { name: /reload page/i })).toBeInTheDocument();
  });

  it("resets error state when retry button is clicked", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>,
    );

    // Error state should be active
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Click retry button
    const retryButton = screen.getByRole("button", { name: /try again/i });
    retryButton.click();

    // Rerender with non-erroring component
    rerender(
      <ErrorBoundary>
        <div data-testid="recovered-content">Recovered</div>
      </ErrorBoundary>,
    );

    // Error state should be cleared
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("recovered-content")).toBeInTheDocument();
  });

  it("logs error to console when caught", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>,
    );

    expect(console.error).toHaveBeenCalledWith(
      "ErrorBoundary caught an error:",
      expect.any(Error),
      expect.objectContaining({
        componentStack: expect.any(String),
      }),
    );
  });

  it("renders default PageError when no custom fallback is provided", () => {
    const ThrowError = () => {
      throw new Error("Test error");
    };

    render(
      <ErrorBoundary>
        <ThrowError />
      </ErrorBoundary>,
    );

    // Verify PageError-specific elements are present
    expect(screen.getByTestId("page-error")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /contact support/i })).toBeInTheDocument();
  });
});
