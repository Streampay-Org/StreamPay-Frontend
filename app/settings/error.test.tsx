/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import SettingsError from "./error";
import { reportClientError } from "@/lib/reportClientError";

jest.mock("@/lib/reportClientError", () => ({
  reportClientError: jest.fn(),
}));

const mockReportClientError = reportClientError as jest.MockedFunction<
  typeof reportClientError
>;

describe("SettingsError", () => {
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

  it("renders the settings-specific heading and reassuring message", () => {
    const error = new Error("Settings render failure") as Error & {
      digest?: string;
    };
    render(<SettingsError error={error} reset={jest.fn()} />);

    expect(
      screen.getByRole("heading", { name: /we couldn't load your settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your preferences and payment data are safe/i),
    ).toBeInTheDocument();
  });

  it("calls reset when Try again is clicked for a standard error", () => {
    const error = new Error("Render failure") as Error & { digest?: string };
    const reset = jest.fn();
    render(<SettingsError error={error} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads the page when Try again is clicked for a chunk-load error", () => {
    const chunkError = Object.assign(new Error("Loading chunk 7 failed"), {
      name: "ChunkLoadError",
    }) as Error & { digest?: string };
    const reset = jest.fn();
    render(<SettingsError error={chunkError} reset={reset} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("reports the error and renders the digest when present", () => {
    const error = Object.assign(new Error("Settings error"), {
      digest: "settings-digest-5",
    });
    render(<SettingsError error={error} reset={jest.fn()} />);

    expect(mockReportClientError).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: "settings-digest-5",
        kind: "boundary",
      }),
    );
    expect(screen.getByText(/settings-digest-5/i)).toBeInTheDocument();
  });

  it("handles non-Error throwables gracefully", () => {
    const reset = jest.fn();
    render(
      <SettingsError
        error={undefined as unknown as Error & { digest?: string }}
        reset={reset}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /we couldn't load your settings/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
