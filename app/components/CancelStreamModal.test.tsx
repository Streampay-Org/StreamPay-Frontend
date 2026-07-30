/**
 * @jest-environment jsdom
 */

import { render, fireEvent } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { CancelStreamModal } from "./CancelStreamModal";
import type { CancelInput } from "../lib/cancel-stream";

const ONE_TOKEN = 10_000_000n; // 1.0 in stroops

const split: CancelInput = {
  totalAmount: 100n * ONE_TOKEN,
  releasedAmount: 0n,
  vestedAmount: 40n * ONE_TOKEN,
  token: "XLM",
  senderAddress: "GSENDER",
  recipientAddress: "GRECIPIENT",
};

const partialReleaseSplit: CancelInput = {
  totalAmount: 100n * ONE_TOKEN,
  releasedAmount: 10n * ONE_TOKEN,
  vestedAmount: 40n * ONE_TOKEN,
  token: "XLM",
  senderAddress: "GSENDER",
  recipientAddress: "GRECIPIENT",
};

const fullyVestedSplit: CancelInput = {
  totalAmount: 100n * ONE_TOKEN,
  releasedAmount: 80n * ONE_TOKEN,
  vestedAmount: 100n * ONE_TOKEN,
  token: "XLM",
  senderAddress: "GSENDER",
  recipientAddress: "GRECIPIENT",
};

describe("CancelStreamModal", () => {
  it("previews the exact refund split before confirming", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
        tokenLabel="XLM"
      />,
    );

    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("40 XLM");
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("60 XLM");
  });

  it("accounts for already-released amounts in the recipient payout", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={partialReleaseSplit}
        tokenLabel="XLM"
      />,
    );

    // recipient keeps: 40 vested - 10 released = 30
    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("30 XLM");
    // sender gets: 100 total - 40 vested = 60
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("60 XLM");
  });

  it("shows zero refund when fully vested", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={fullyVestedSplit}
        tokenLabel="XLM"
      />,
    );

    // recipient keeps: 100 vested - 80 released = 20
    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("20 XLM");
    // sender gets: 100 total - 100 vested = 0
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("0 XLM");
  });

  it("invokes onConfirm when confirming a cancellable stream", async () => {
    const onConfirm = jest.fn();
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={onConfirm}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("blocks cancellation and disables confirm for terminal streams", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "cancelled" }}
        split={split}
      />,
    );

    expect(screen.getByTestId("cancel-blocked")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirm cancellation/i }),
    ).toBeDisabled();
  });

  it("blocks cancellation for ended streams", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "ended" }}
        split={split}
      />,
    );

    expect(screen.getByTestId("cancel-blocked")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirm cancellation/i }),
    ).toBeDisabled();
  });

  it("blocks cancellation for withdrawn streams", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "withdrawn" }}
        split={split}
      />,
    );

    expect(screen.getByTestId("cancel-blocked")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirm cancellation/i }),
    ).toBeDisabled();
  });

  it("blocks cancellation for draft streams", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "draft" }}
        split={split}
      />,
    );

    expect(screen.getByTestId("cancel-blocked")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirm cancellation/i }),
    ).toBeDisabled();
  });

  it("calls onClose when Keep stream is clicked", () => {
    const onClose = jest.fn();
    render(
      <CancelStreamModal
        isOpen
        onClose={onClose}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /keep stream/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the warning about irreversible action", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    expect(
      screen.getByText(/this action cannot be undone/i),
    ).toBeInTheDocument();
  });

  it("shows review text for split preview", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    expect(
      screen.getByText(/review the exact refund split/i),
    ).toBeInTheDocument();
  });

  it("uses custom tokenLabel", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
        tokenLabel="USDC"
      />,
    );

    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("40 USDC");
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("60 USDC");
  });

  it("disables the confirm button while submitting", () => {
    const onConfirm = jest.fn(() => new Promise<void>(() => {})); // never resolves
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={onConfirm}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));
    expect(screen.getByRole("button", { name: /cancelling/i })).toBeDisabled();
  });

  it("renders the modal title", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={{ status: "active" }}
        split={split}
      />,
    );

    expect(screen.getByRole("dialog", { name: /cancel stream/i })).toBeInTheDocument();
  });
});
