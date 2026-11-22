/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import StreamsError from "./error";
import { reportClientError } from "@/lib/reportClientError";

jest.mock("@/lib/reportClientError", () => ({
  reportClientError: jest.fn(),
}));

const mockReportClientError = reportClientError as jest.MockedFunction<
  typeof reportClientError
>;

describe("StreamsError", () => {
  const originalLocation = window.location;
  let reloadMock: jest.Mock;

  beforeEach(() => {
    reloadMock = jest.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload: reloadMock },
    });
    mockReportClientError.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("renders the streams-specific heading and reassuring message", () => {
    const error = new Error("Streams render failure") as Error & {
      digest?: string;
    };
    render(<StreamsError error={error} reset={jest.fn()} />);

    expect(
      screen.getByRole("heading", { name: /we couldn't load your streams/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/your payment data is safe/i)).toBeInTheDocument();
  });

  it("calls reset when Try again is clicked for a standard error", () => {
    const error = new Error("Render failure") as Error & { digest?: string };
    const reset = jest.fn();
    render(<StreamsError error={error} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads the page when Try again is clicked for a chunk-load error", () => {
    const chunkError = Object.assign(
      new Error("Loading chunk 42 failed."),
      { name: "ChunkLoadError" },
    ) as Error & { digest?: string };
    const reset = jest.fn();
    render(<StreamsError error={chunkError} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("reports the error through reportClientError", () => {
    const error = Object.assign(new Error("Server error"), {
      digest: "streams-digest-1",
    });
    render(<StreamsError error={error} reset={jest.fn()} />);

    expect(mockReportClientError).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: "streams-digest-1",
        message: "Server error",
        kind: "boundary",
      }),
    );
    expect(screen.getByText(/streams-digest-1/i)).toBeInTheDocument();
  });

  it("handles non-Error throwables gracefully", () => {
    const reset = jest.fn();
    render(
      <StreamsError
        error={"unexpected string error" as unknown as Error & { digest?: string }}
        reset={reset}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /we couldn't load your streams/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
