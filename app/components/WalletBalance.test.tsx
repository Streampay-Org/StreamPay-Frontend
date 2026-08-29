/**
 * @jest-environment jsdom
 */

import { render, waitFor, fireEvent } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { WalletBalance } from "./WalletBalance";

describe("WalletBalance", () => {
  it("renders the resolved balance with the asset code", async () => {
    const fetchBalance = jest.fn().mockResolvedValue("100.50");

    render(<WalletBalance fetchBalance={fetchBalance} assetCode="XLM" />);

    expect(await screen.findByText("100.50 XLM")).toBeInTheDocument();
    expect(fetchBalance).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when the balance cannot be fetched", async () => {
    const fetchBalance = jest.fn().mockRejectedValue(new Error("network"));

    render(<WalletBalance fetchBalance={fetchBalance} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Balance unavailable",
    );
  });

  it("re-fetches when the manual refresh button is pressed", async () => {
    const fetchBalance = jest
      .fn()
      .mockResolvedValueOnce("1.00")
      .mockResolvedValueOnce("2.00");

    render(<WalletBalance fetchBalance={fetchBalance} assetCode="XLM" />);
    await screen.findByText("1.00 XLM");

    fireEvent.click(screen.getByLabelText("Refresh balance now"));

    await waitFor(() => expect(screen.getByText("2.00 XLM")).toBeInTheDocument());
    expect(fetchBalance).toHaveBeenCalledTimes(2);
  });

  it("ignores stale refresh results when a newer refresh has started", async () => {
    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    const fetchBalance = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(<WalletBalance fetchBalance={fetchBalance} assetCode="XLM" />);
    fireEvent.click(screen.getByLabelText("Refresh balance now"));

    resolveSecond("2.00");
    expect(await screen.findByText("2.00 XLM")).toBeInTheDocument();

    resolveFirst("1.00");
    await waitFor(() => expect(screen.queryByText("1.00 XLM")).not.toBeInTheDocument());
  });

  it("aborts in-flight refresh work on replacement and unmount", async () => {
    const signals: AbortSignal[] = [];
    const fetchBalance = jest.fn((signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<string>(() => {});
    });

    const { unmount } = render(<WalletBalance fetchBalance={fetchBalance} />);
    await waitFor(() => expect(fetchBalance).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText("Refresh balance now"));

    expect(fetchBalance).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    unmount();

    expect(signals[1].aborted).toBe(true);
  });
});
