/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { ConfirmPauseModal } from "./ConfirmPauseModal";

describe("ConfirmPauseModal", () => {
  const baseProps = {
    isOpen: true,
    onClose: jest.fn(),
    onConfirm: jest.fn().mockResolvedValue(undefined),
    streamId: "stream-ada",
    amountLabel: "120 XLM",
    recipientLabel: "Ada Creative Studio",
    timingLabel: "Pays every 30 days",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows stream, amount, recipient, and timing", () => {
    render(React.createElement(ConfirmPauseModal, baseProps));

    expect(screen.getByRole("dialog", { name: /pause stream/i })).toBeInTheDocument();
    expect(screen.getByTestId("pause-stream-id")).toHaveTextContent("stream-ada");
    expect(screen.getByTestId("pause-amount")).toHaveTextContent("120 XLM");
    expect(screen.getByTestId("pause-recipient")).toHaveTextContent(
      "Ada Creative Studio",
    );
    expect(screen.getByTestId("pause-timing")).toHaveTextContent(
      "Pays every 30 days",
    );
    expect(
      screen.getByText(/not a cancellation/i),
    ).toBeInTheDocument();
  });

  it("calls onConfirm once and closes on success", async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    render(
      React.createElement(ConfirmPauseModal, {
        ...baseProps,
        onConfirm,
        onClose,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("pause-confirm"));
    });

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("blocks duplicate clicks while pending", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(
      React.createElement(ConfirmPauseModal, {
        ...baseProps,
        onConfirm,
      }),
    );

    fireEvent.click(screen.getByTestId("pause-confirm"));
    fireEvent.click(screen.getByTestId("pause-confirm"));
    fireEvent.click(screen.getByTestId("pause-confirm"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /pausing/i })).toBeDisabled();

    await act(async () => {
      resolveConfirm();
    });
  });

  it("surfaces rejection and keeps the modal open", async () => {
    const onConfirm = jest
      .fn()
      .mockRejectedValue(new Error("User rejected the request"));
    const onClose = jest.fn();

    render(
      React.createElement(ConfirmPauseModal, {
        ...baseProps,
        onConfirm,
        onClose,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("pause-confirm"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("pause-error")).toHaveTextContent(
        /user rejected/i,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("pause-confirm")).not.toBeDisabled();
  });

  it("surfaces timeout failures without closing", async () => {
    const onConfirm = jest
      .fn()
      .mockRejectedValue(new Error("Request timed out"));
    const onClose = jest.fn();

    render(
      React.createElement(ConfirmPauseModal, {
        ...baseProps,
        onConfirm,
        onClose,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("pause-confirm"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("pause-error")).toHaveTextContent(/timed out/i),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
