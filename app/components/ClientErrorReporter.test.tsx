/**
 * @jest-environment jsdom
 */

import React from "react";
import { render } from "@testing-library/react";
import { reportClientError } from "@/lib/reportClientError";
import { ClientErrorReporter } from "./ClientErrorReporter";

jest.mock("@/lib/reportClientError", () => ({
  reportClientError: jest.fn(),
}));

const mockedReportClientError = reportClientError as jest.MockedFunction<
  typeof reportClientError
>;

function createRejectionEvent(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", {
    value: reason,
    configurable: true,
  });
  return event;
}

describe("ClientErrorReporter", () => {
  beforeEach(() => {
    mockedReportClientError.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders null", () => {
    const { container } = render(<ClientErrorReporter />);
    expect(container.firstChild).toBeNull();
  });

  it("registers error and unhandledrejection listeners once on mount, does not duplicate on re-render, and removes the same handlers on unmount", () => {
    const addSpy = jest.spyOn(window, "addEventListener");
    const removeSpy = jest.spyOn(window, "removeEventListener");

    const { rerender, unmount } = render(<ClientErrorReporter />);

    const errorAdds = addSpy.mock.calls.filter(([type]) => type === "error");
    const rejectionAdds = addSpy.mock.calls.filter(
      ([type]) => type === "unhandledrejection"
    );

    expect(errorAdds).toHaveLength(1);
    expect(rejectionAdds).toHaveLength(1);

    const errorHandler = errorAdds[0][1];
    const rejectionHandler = rejectionAdds[0][1];

    rerender(<ClientErrorReporter />);

    expect(
      addSpy.mock.calls.filter(([type]) => type === "error")
    ).toHaveLength(1);
    expect(
      addSpy.mock.calls.filter(([type]) => type === "unhandledrejection")
    ).toHaveLength(1);

    unmount();

    const errorRemovals = removeSpy.mock.calls.filter(
      ([type]) => type === "error"
    );
    const rejectionRemovals = removeSpy.mock.calls.filter(
      ([type]) => type === "unhandledrejection"
    );

    expect(errorRemovals).toHaveLength(1);
    expect(errorRemovals[0][1]).toBe(errorHandler);
    expect(rejectionRemovals).toHaveLength(1);
    expect(rejectionRemovals[0][1]).toBe(rejectionHandler);
  });

  it("reports window error events with Error details", () => {
    render(<ClientErrorReporter />);

    const err = new TypeError("Boom");
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Uncaught TypeError: Boom",
        error: err,
      })
    );

    expect(mockedReportClientError).toHaveBeenCalledTimes(1);
    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "TypeError",
      message: "Uncaught TypeError: Boom",
      stack: err.stack,
      kind: "unhandled",
    });
  });

  it("falls back to event.error.message when event.message is empty", () => {
    render(<ClientErrorReporter />);

    const err = new Error("Inner error message");
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "",
        error: err,
      })
    );

    expect(mockedReportClientError).toHaveBeenCalledTimes(1);
    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "Error",
      message: "Inner error message",
      stack: err.stack,
      kind: "unhandled",
    });
  });

  it("handles error events when event.error is undefined and falls back to Unknown error", () => {
    render(<ClientErrorReporter />);

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Script error.",
        error: undefined,
      })
    );

    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "Error",
      message: "Script error.",
      stack: undefined,
      kind: "unhandled",
    });

    mockedReportClientError.mockClear();

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "",
        error: undefined,
      })
    );

    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "Error",
      message: "Unknown error",
      stack: undefined,
      kind: "unhandled",
    });
  });

  it("reports unhandledrejection events with a string reason", () => {
    render(<ClientErrorReporter />);

    window.dispatchEvent(createRejectionEvent("Network request failed"));

    expect(mockedReportClientError).toHaveBeenCalledTimes(1);
    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "UnhandledRejection",
      message: "Network request failed",
      stack: undefined,
      kind: "unhandled",
    });
  });

  it("reports unhandledrejection events with an Error reason", () => {
    render(<ClientErrorReporter />);

    const err = new Error("Async failure");
    window.dispatchEvent(createRejectionEvent(err));

    expect(mockedReportClientError).toHaveBeenCalledTimes(1);
    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "UnhandledRejection",
      message: "Async failure",
      stack: err.stack,
      kind: "unhandled",
    });
  });

  it("reports unhandledrejection events with empty or null reason using fallback message", () => {
    render(<ClientErrorReporter />);

    window.dispatchEvent(createRejectionEvent(undefined));

    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "UnhandledRejection",
      message: "Unhandled promise rejection",
      stack: undefined,
      kind: "unhandled",
    });

    mockedReportClientError.mockClear();

    window.dispatchEvent(createRejectionEvent(null));

    expect(mockedReportClientError).toHaveBeenCalledWith({
      name: "UnhandledRejection",
      message: "Unhandled promise rejection",
      stack: undefined,
      kind: "unhandled",
    });
  });

  it("does not call reportClientError when events are dispatched after unmount", () => {
    const { unmount } = render(<ClientErrorReporter />);

    unmount();

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Post-unmount error",
      })
    );
    window.dispatchEvent(createRejectionEvent("Post-unmount rejection"));

    expect(mockedReportClientError).not.toHaveBeenCalled();
  });
});
