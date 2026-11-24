/**
 * @jest-environment jsdom
 */

import { render, fireEvent, waitFor } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { CancelStreamModal } from "./CancelStreamModal";
import type { CancelInput } from "../lib/cancel-stream";
import type { Stream } from "../types/openapi";

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

function streamFrom(input: CancelInput, status: Stream["status"]): Stream {
  return {
    id: "stream-preview",
    recipient: input.recipientAddress,
    senderAddress: input.senderAddress,
    rate: "1",
    schedule: "day",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    token: input.token,
    totalAmount: input.totalAmount.toString(),
    releasedAmount: input.releasedAmount.toString(),
    vestedAmount: input.vestedAmount.toString(),
  };
}

describe("CancelStreamModal", () => {
  it("previews the exact refund split before confirming", () => {
    render(
      <CancelStreamModal
        isOpen
        onClose={jest.fn()}
        onConfirm={jest.fn()}
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(partialReleaseSplit, "active")}
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
        stream={streamFrom(fullyVestedSplit, "active")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "cancelled")}
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
        stream={streamFrom(split, "ended")}
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
        stream={streamFrom(split, "withdrawn")}
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
        stream={streamFrom(split, "draft")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "active")}
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
        stream={streamFrom(split, "active")}
      />,
    );

    expect(screen.getByRole("dialog", { name: /cancel stream/i })).toBeInTheDocument();
  });

  it("displays server-provided numbers when GET /cancel/preview succeeds", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          action: "cancel",
          allowed: true,
          currentStatus: "active",
          nextStatus: "cancelled",
          token: "XLM",
          totalAmount: (100n * ONE_TOKEN).toString(),
          releasedAmount: "0",
          vestedAmount: (55n * ONE_TOKEN).toString(),
          recipientPayout: (55n * ONE_TOKEN).toString(),
          senderRefund: (45n * ONE_TOKEN).toString(),
          escrowDrained: (100n * ONE_TOKEN).toString(),
          asOf: "2026-01-01T12:00:00.000Z",
        },
      }),
    }) as unknown as typeof fetch;

    try {
      render(
        <CancelStreamModal
          isOpen
          onClose={jest.fn()}
          onConfirm={jest.fn()}
          stream={streamFrom(split, "active")}
          tokenLabel="XLM"
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("recipient-payout")).toHaveTextContent("55 XLM");
        expect(screen.getByTestId("sender-refund")).toHaveTextContent("45 XLM");
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/streams/stream-preview/cancel/preview",
        expect.objectContaining({ method: "GET" }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to local computation when offline (fetch fails)", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

    try {
      render(
        <CancelStreamModal
          isOpen
          onClose={jest.fn()}
          onConfirm={jest.fn()}
          stream={streamFrom(split, "active")}
          tokenLabel="XLM"
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("cancel-preview-error")).toBeInTheDocument();
      });
      expect(screen.getByTestId("recipient-payout")).toHaveTextContent("40 XLM");
      expect(screen.getByTestId("sender-refund")).toHaveTextContent("60 XLM");
      expect(screen.getByRole("button", { name: /confirm cancellation/i })).not.toBeDisabled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("blocks confirmation when server preview returns 409", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: "ILLEGAL_TRANSITION",
          message: "Stream is already cancelled on server.",
        },
      }),
    }) as unknown as typeof fetch;

    try {
      render(
        <CancelStreamModal
          isOpen
          onClose={jest.fn()}
          onConfirm={jest.fn()}
          stream={streamFrom(split, "active")}
          tokenLabel="XLM"
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId("cancel-blocked")).toHaveTextContent(
          "Stream is already cancelled on server.",
        );
      });
      expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeDisabled();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
