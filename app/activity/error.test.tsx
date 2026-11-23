/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import ActivityError from "./error";
import { reportClientError } from "@/lib/reportClientError";

jest.mock("@/lib/reportClientError", () => ({
  reportClientError: jest.fn(),
}));

const mockReportClientError = reportClientError as jest.MockedFunction<
  typeof reportClientError
>;

describe("ActivityError", () => {
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

  it("renders the activity-specific heading and reassuring message", () => {
    const error = new Error("Activity render failure") as Error & {
      digest?: string;
    };
    render(<ActivityError error={error} reset={jest.fn()} />);

    expect(
      screen.getByRole("heading", { name: /we couldn't load your activity/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your transaction history and funds are safe/i),
    ).toBeInTheDocument();
  });

  it("calls reset when Try again is clicked for a standard error", () => {
    const error = new Error("Render failure") as Error & { digest?: string };
    const reset = jest.fn();
    render(<ActivityError error={error} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads the page when Try again is clicked for a chunk-load error", () => {
    const chunkError = new Error(
      "Failed to fetch dynamically imported module: /_next/static/chunks/activity.js",
    ) as Error & { digest?: string };
    const reset = jest.fn();
    render(<ActivityError error={chunkError} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("reports the error and renders the digest when present", () => {
    const error = Object.assign(new Error("Activity error"), {
      digest: "activity-digest-2",
    });
    render(<ActivityError error={error} reset={jest.fn()} />);

    expect(mockReportClientError).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: "activity-digest-2",
        kind: "boundary",
      }),
    );
    expect(screen.getByText(/activity-digest-2/i)).toBeInTheDocument();
  });

  it("handles non-Error throwables gracefully", () => {
    const reset = jest.fn();
    render(
      <ActivityError
        error={null as unknown as Error & { digest?: string }}
        reset={reset}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /we couldn't load your activity/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
