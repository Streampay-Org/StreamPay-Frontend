/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { Stream } from "../../types/openapi";

jest.mock("../../../lib/apiClient", () => ({
  fetchWithIdempotency: jest.fn().mockResolvedValue({ ok: true }),
}));

const RequestCtor = globalThis.Request ?? class Request {};
const ResponseCtor = globalThis.Response ?? class Response {};
const HeadersCtor = globalThis.Headers ?? class Headers {};
(global as typeof globalThis & { Request: typeof RequestCtor }).Request = RequestCtor;
(global as typeof globalThis & { Response: typeof ResponseCtor }).Response = ResponseCtor;
(global as typeof globalThis & { Headers: typeof HeadersCtor }).Headers = HeadersCtor;

const { StreamDetailClient } = require("./StreamDetailClient") as typeof import("./StreamDetailClient");

const activeStream: Stream = {
  id: "stream-ada",
  recipient: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
  rate: "120 XLM / month",
  schedule: "Pays every 30 days",
  status: "active",
  label: "Ada Creative Studio",
  email: "ada@example.com",
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-27T10:00:00.000Z",
  token: "XLM",
  totalAmount: "3600000000",
  vestedAmount: "1800000000",
  releasedAmount: "1200000000",
  senderAddress: "GSENDER00000000000000000000000000000000000000000000",
};

const endedStream: Stream = {
  id: "stream-yusuf",
  recipient: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ87WGNB55IAA",
  rate: "18 XLM / day",
  schedule: "Ended yesterday with funds available",
  status: "ended",
  label: "Yusuf QA Partnership",
  createdAt: "2024-10-01T08:00:00.000Z",
  updatedAt: "2024-11-19T17:45:00.000Z",
  token: "XLM",
  totalAmount: "540000000",
  vestedAmount: "540000000",
  releasedAmount: "0",
  senderAddress: "GSENDER00000000000000000000000000000000000000000000",
  withdrawal: {
    state: "pending",
    requestedAt: "2024-11-19T18:00:00.000Z",
    lastCheckedAt: "2024-11-19T18:05:00.000Z",
    attempts: 1,
  },
};

describe("StreamDetailClient", () => {
  it("links to the contract events panel for the current stream", () => {
    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    const eventsLink = screen.getByRole("link", { name: /view contract events/i });

    expect(eventsLink).toBeInTheDocument();
    expect(eventsLink).toHaveAttribute("href", "/streams/stream-ada/events");
  });

  it("opens CancelStreamModal with refund preview for active streams", () => {
    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /cancel stream/i }));

    const dialog = screen.getByRole("dialog", { name: /cancel stream/i });
    expect(dialog).toBeInTheDocument();

    expect(screen.getByText(/review the exact refund split/i)).toBeInTheDocument();
    expect(screen.getByTestId("recipient-payout")).toBeInTheDocument();
    expect(screen.getByTestId("sender-refund")).toBeInTheDocument();
  });

  it("shows correct refund split in the cancel modal", () => {
    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /cancel stream/i }));

    expect(screen.getByTestId("recipient-payout")).toHaveTextContent("60 XLM");
    expect(screen.getByTestId("sender-refund")).toHaveTextContent("180 XLM");
  });

  it("disables confirm button for terminal streams", () => {
    render(React.createElement(StreamDetailClient, { stream: endedStream }));

    fireEvent.click(screen.getByRole("button", { name: /withdraw funds/i }));

    const dialog = screen.getByRole("dialog", { name: /withdraw funds/i });
    expect(dialog).toBeInTheDocument();
  });

  it("shows the destructive cancel button for active streams", () => {
    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    expect(screen.getByRole("button", { name: /cancel stream/i })).toBeInTheDocument();
  });

  it("shows the destructive withdraw button for ended streams", () => {
    render(React.createElement(StreamDetailClient, { stream: endedStream }));

    expect(screen.getByRole("button", { name: /withdraw funds/i })).toBeInTheDocument();
  });
});
