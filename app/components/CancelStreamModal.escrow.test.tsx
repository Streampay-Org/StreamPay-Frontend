/** @jest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { CancelStreamModal } from "./CancelStreamModal";
import type { Stream } from "../types/openapi";
import { POST as cancelStream } from "../api/streams/[id]/cancel/route";
import { db, resetDb } from "../lib/db";
import { resetRateLimitStore } from "../lib/rate-limit-store";
import { signToken } from "../lib/auth";

jest.mock("../lib/escrow-state", () => ({
  ...jest.requireActual("../lib/escrow-state"),
  escrowNow: () => new Date("2026-01-01T06:00:00.000Z"),
}));

const now = new Date("2026-01-01T06:00:00.000Z");
const stream: Stream = {
  id: "stream-test",
  recipient: "GRECIPIENT",
  senderAddress: "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H",
  ownership: "individual",
  rate: "1",
  schedule: "day",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  token: "XLM",
  totalAmount: "2000000000",
  releasedAmount: "100000000",
  startTime: "2026-01-01T00:00:00.000Z",
  endTime: "2026-01-02T00:00:00.000Z",
};

function show(record: Stream = stream, onConfirm = jest.fn(), onClose = jest.fn(), tokenLabel = "XLM") {
  render(
    <CancelStreamModal
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      stream={record}
      now={now}
      tokenLabel={tokenLabel}
    />,
  );
  return { onConfirm, onClose };
}

describe("CancelStreamModal", () => {
  it("uses the persisted 2e9 escrow and linear vesting for the preview", () => {
    show();
    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("40 XLM");
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("150 XLM");
    expect(screen.getByText(/review the exact refund split/i)).toBeInTheDocument();
  });

  it("disables confirmation when escrow amounts are unavailable", () => {
    show({ ...stream, totalAmount: undefined });
    expect(screen.getByTestId("cancel-blocked")).toHaveTextContent("Escrow state is unavailable");
    expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeDisabled();
  });

  it("disables confirmation for an invalid escrow invariant", () => {
    show({ ...stream, releasedAmount: "600000000" });
    expect(screen.getByTestId("cancel-blocked")).toHaveTextContent("Escrow invariant violated");
    expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeDisabled();
  });

  it("blocks terminal and draft streams", () => {
    for (const status of ["cancelled", "ended", "withdrawn", "draft"] as const) {
      const { unmount } = render(
        <CancelStreamModal isOpen onClose={jest.fn()} onConfirm={jest.fn()} stream={{ ...stream, status }} now={now} />,
      );
      expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeDisabled();
      unmount();
    }
  });

  it("confirms a valid cancellation", async () => {
    const { onConfirm } = show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/this action cannot be undone/i)).toBeInTheDocument();
  });

  it("lets the user keep the stream", () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: /keep stream/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses a custom token label and renders the dialog title", () => {
    show(stream, jest.fn(), jest.fn(), "USDC");
    expect(screen.getByRole("dialog", { name: /cancel stream/i })).toBeInTheDocument();
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("150 USDC");
  });

  it("disables confirmation while submitting", () => {
    show(stream, jest.fn(() => new Promise<void>(() => {})));
    fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));
    expect(screen.getByRole("button", { name: /cancelling/i })).toBeDisabled();
  });

  it("shows the same payout and refund returned by the route at the same time", async () => {
    resetDb();
    resetRateLimitStore();
    db.streams.set(stream.id, stream);
    show();
    const previewPayout = screen.getByTestId("recipient-payout").textContent;
    const previewRefund = screen.getByTestId("sender-refund").textContent;
    const response = await cancelStream(
        new Request(`http://localhost/api/streams/${stream.id}/cancel`, {
          method: "POST",
          headers: { Authorization: `Bearer ${signToken(stream.senderAddress!)}` },
        }),
        { params: Promise.resolve({ id: stream.id }) },
      );
    expect(response.status).toBe(200);
    const { cancellation } = await response.json();
    expect(previewPayout).toBe(`${BigInt(cancellation.recipientPayout) / 10_000_000n} XLM`);
    expect(previewRefund).toBe(`${BigInt(cancellation.senderRefund) / 10_000_000n} XLM`);
  });
});
