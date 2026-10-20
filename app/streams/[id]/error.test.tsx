/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react";
import StreamDetailError from "./error";

const mockError = new Error("Test render failure") as Error & { digest?: string };

describe("StreamDetailError", () => {
  it("renders the stream-specific heading", () => {
    render(<StreamDetailError error={mockError} reset={jest.fn()} />);
    expect(
      screen.getByRole("heading", { name: /we couldn't load this stream/i }),
    ).toBeInTheDocument();
  });

  it("renders the reassuring body message", () => {
    render(<StreamDetailError error={mockError} reset={jest.fn()} />);
    expect(screen.getByText(/your payment data is safe/i)).toBeInTheDocument();
  });

  it("renders the Try again button and calls reset on click", () => {
    const reset = jest.fn();
    render(<StreamDetailError error={mockError} reset={reset} />);

    const btn = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(btn);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("renders a Back to streams link pointing to /streams", () => {
    render(<StreamDetailError error={mockError} reset={jest.fn()} />);
    const link = screen.getByRole("link", { name: /back to streams/i });
    expect(link).toHaveAttribute("href", "/streams");
  });

  it("renders the error digest as a support reference when present", () => {
    const errorWithDigest = Object.assign(new Error("Server error"), {
      digest: "abc-123-digest",
    });
    render(<StreamDetailError error={errorWithDigest} reset={jest.fn()} />);
    expect(screen.getByText(/abc-123-digest/i)).toBeInTheDocument();
  });
});
