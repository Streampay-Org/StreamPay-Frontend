"use client";

import { Component, ReactNode } from "react";
import { PageError } from "./PageError";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback UI. If not provided, uses default PageError. */
  fallback?: ReactNode;
  /** Called when an error is caught, useful for error reporting/telemetry. */
  onError?: (error: Error, errorInfo: { componentStack: string }) => void;
  /** Override the error heading. */
  errorHeading?: string;
  /** Override the error message. */
  errorMessage?: string;
  /** Override the retry button label. */
  retryLabel?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary component that catches JavaScript errors in child component tree.
 *
 * Catches errors during rendering, in lifecycle methods, and in constructors of the whole tree below them.
 * Provides a fallback UI and retry functionality. Logs errors for telemetry/reporting.
 *
 * @example
 * ```tsx
 * <ErrorBoundary
 *   onError={(error, errorInfo) => reportError(error, errorInfo)}
 *   errorHeading="Something went wrong"
 *   errorMessage="Please try again or contact support if the problem persists."
 * >
 *   <YourComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: { componentStack: string }): void {
    // Log error for telemetry/reporting
    console.error("ErrorBoundary caught an error:", error, errorInfo);

    // Call custom error handler if provided
    this.props.onError?.(error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Otherwise use default PageError component
      return (
        <PageError
          heading={this.props.errorHeading || "Something went wrong"}
          message={
            this.props.errorMessage ||
            "An unexpected error occurred. Please try again or contact support if the problem persists."
          }
          onRetry={this.handleReset}
          retryLabel={this.props.retryLabel || "Try again"}
        />
      );
    }

    return this.props.children;
  }
}
