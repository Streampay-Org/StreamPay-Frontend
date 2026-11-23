/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import React from "react";
import type { Stream } from "../../types/openapi";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();

function idempotencyKeyForCall(index: number): string | null {
  const init = mockFetch.mock.calls[index]?.[1];
  return new Headers(init?.headers).get("Idempotency-Key");
}

function pausedStream(): Stream {
  return {
    ...activeStream,
    status: "paused",
    updatedAt: "2026-06-27T10:05:00.000Z",
  };
}

function cancelledStream(): Stream {
  return {
    ...activeStream,
    status: "cancelled",
    updatedAt: "2026-06-27T10:10:00.000Z",
  };
}

describe("StreamDetailClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
    jest.spyOn(window, "alert").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it("shows chain mismatch before enabling stream mutations", () => {
    render(
      React.createElement(StreamDetailClient, {
        stream: activeStream,
        network: "mainnet",
        walletNetwork: "testnet",
      }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("this app requires");
    expect(screen.getByRole("button", { name: /^Pause$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel stream/i })).toBeDisabled();
  });

  it("shows the destructive withdraw button for ended streams", () => {
    render(React.createElement(StreamDetailClient, { stream: endedStream }));

    expect(screen.getByRole("button", { name: /withdraw funds/i })).toBeInTheDocument();
  });

  it("reuses the same Idempotency-Key when the user retries a retryable failure", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "GATEWAY_TIMEOUT",
              message: "Upstream timed out",
              request_id: "req-504",
            },
          },
          504,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    const retry = await screen.findByRole("button", { name: /^retry$/i });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByTestId("action-status")).toHaveTextContent(/pause successful/i);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(idempotencyKeyForCall(0)).toEqual(expect.any(String));
    expect(idempotencyKeyForCall(0)).toBe(idempotencyKeyForCall(1));
  });

  it("updates the badge and next action from the mutation response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Stream status: Paused")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^Resume$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pause$/i })).not.toBeInTheDocument();
  });

  it("clears the key after a non-retryable error so the next click uses a new key", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "INVALID_STREAM_STATE",
              message: "Cannot pause a stream in 'paused' status.",
              request_id: "req-409",
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await screen.findByTestId("error-toast");
    expect(screen.queryByRole("button", { name: /^retry$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    expect(idempotencyKeyForCall(0)).toEqual(expect.any(String));
    expect(idempotencyKeyForCall(1)).toEqual(expect.any(String));
    expect(idempotencyKeyForCall(0)).not.toBe(idempotencyKeyForCall(1));
  });

  it("uses different keys for a pause followed by a cancel", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: pausedStream() }))
      .mockResolvedValueOnce(jsonResponse({ data: cancelledStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Stream status: Paused")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /cancel stream/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm cancellation/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Stream status: Cancelled")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(idempotencyKeyForCall(0)).toEqual(expect.any(String));
    expect(idempotencyKeyForCall(1)).toEqual(expect.any(String));
    expect(idempotencyKeyForCall(0)).not.toBe(idempotencyKeyForCall(1));
  });

  it("ignores a second click while the first request is in flight", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;

    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    const actionButton = screen.getByRole("button", { name: /^Pause$/i });
    fireEvent.click(actionButton);
    fireEvent.click(actionButton);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(actionButton).toBeDisabled();

    await act(async () => {
      resolveRequest?.(jsonResponse({ data: pausedStream() }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stream status: Paused")).toBeInTheDocument();
    });
  });

  it("announces success in a live status region and moves focus there", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    const status = await screen.findByTestId("action-status");

    await waitFor(() => {
      expect(status).toHaveTextContent(/pause successful/i);
    });

    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveFocus();
  });

  it("has no accessibility violations after a successful action", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    const { container } = render(
      React.createElement(StreamDetailClient, { stream: activeStream }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("action-status")).toHaveTextContent(/pause successful/i);
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it("confirms a destructive withdraw with its own idempotency key", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { ...endedStream, status: "withdrawn" } }),
    );

    render(React.createElement(StreamDetailClient, { stream: endedStream }));

    fireEvent.click(screen.getByRole("button", { name: /withdraw funds/i }));

    const dialog = screen.getByRole("dialog", { name: /withdraw funds/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^continue$/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: /^withdraw funds$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("action-status")).toHaveTextContent(/withdraw successful/i);
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(idempotencyKeyForCall(0)).toEqual(expect.any(String));
    expect(String(mockFetch.mock.calls[0][1]?.body)).toContain("18 XLM");
  });

  it("reports calendar export failures inline without calling alert", () => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(
      screen.getByRole("button", { name: /export vesting calendar as ics file/i }),
    );

    expect(screen.getByTestId("action-status")).toHaveTextContent(
      /failed to export vesting calendar/i,
    );
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("does not call window.alert on a successful action", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: pausedStream() }));

    render(React.createElement(StreamDetailClient, { stream: activeStream }));

    fireEvent.click(screen.getByRole("button", { name: /^Pause$/i }));

    await waitFor(() => {
      expect(screen.getByTestId("action-status")).toHaveTextContent(/pause successful/i);
    });

    expect(window.alert).not.toHaveBeenCalled();
  });
});
