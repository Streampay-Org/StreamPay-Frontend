/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ContractEvent } from "../../../components/EventTimeline";
import type { StreamHistoryEntry } from "@/app/lib/repositories/stream-history";

// The timeline itself is covered by page.test.tsx; this suite focuses on the
// pagination behaviour of the client wrapper, so the child is stubbed to keep
// assertions on the mapped events and props direct (and to allow an unknown
// history type to be exercised without the timeline's presentation metadata).
jest.mock("../../../components/EventTimeline", () => {
  const React = require("react");
  return {
    EventTimeline: ({
      events,
      hasMore,
      onLoadMore,
      loadingMore,
    }: {
      events: { id: string; summary: string; amount?: string }[];
      hasMore?: boolean;
      onLoadMore?: () => void;
      loadingMore?: boolean;
    }) =>
      React.createElement(
        "section",
        { "aria-label": "event timeline" },
        React.createElement(
          "p",
          { role: "status" },
          `Showing ${events.length} event${events.length === 1 ? "" : "s"}`,
        ),
        React.createElement(
          "ul",
          null,
          events.map((event) =>
            React.createElement(
              "li",
              { key: event.id, "data-amount": event.amount },
              event.summary,
            ),
          ),
        ),
        hasMore && onLoadMore
          ? React.createElement(
              "button",
              { type: "button", onClick: onLoadMore, disabled: loadingMore },
              loadingMore ? "Loading…" : "Load more",
            )
          : null,
      ),
  };
});

import { StreamEventsClient } from "./StreamEventsClient";

const initialEvents: ContractEvent[] = [
  {
    id: "e1",
    type: "created",
    summary: "Stream created",
    timestamp: "2026-06-01T09:00:00.000Z",
  },
];

// Deliberately contains "&" and "=" to prove the cursor is URL-encoded.
const initialCursor = "2026-06-01T09:00:00.000Z&e1=1";

function historyEntry(
  overrides: Partial<StreamHistoryEntry> & Pick<StreamHistoryEntry, "id" | "type">,
): StreamHistoryEntry {
  return {
    streamId: "stream-ada",
    toStatus: "active",
    at: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function historyResponse(
  data: StreamHistoryEntry[],
  nextCursor: string | null,
  init: { ok?: boolean; status?: number } = {},
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ data, meta: { nextCursor } }),
  };
}

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("StreamEventsClient", () => {
  it("loads the next page, appends mapped events and advances the cursor", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(
        historyResponse(
          [
            historyEntry({
              id: "e2",
              type: "paused",
              at: "2026-06-01T10:00:00.000Z",
            }),
          ],
          "next-page",
        ),
      )
      .mockResolvedValueOnce(historyResponse([], null));

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    expect(screen.getByText("Stream created")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(screen.getByText("Stream paused; accrual frozen")).toBeInTheDocument(),
    );
    expect(screen.getByText("Stream created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 events");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/streams/stream-ada/history?cursor=${encodeURIComponent(initialCursor)}&limit=20`,
      { headers: { "x-tenant-id": "default" } },
    );

    // The cursor returned by the first page must drive the next request.
    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/streams/stream-ada/history?cursor=next-page&limit=20",
      { headers: { "x-tenant-id": "default" } },
    );
  });

  it("hides Load more when the response ends the cursor", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(historyResponse([], null));

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor="only-page"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Stream created")).toBeInTheDocument();
  });

  it("does not render Load more when there is no initial cursor", () => {
    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={null}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an alert for a non-OK response, keeps events and allows retry", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(historyResponse([], null, { ok: false, status: 500 }))
      .mockResolvedValueOnce(
        historyResponse([historyEntry({ id: "e2", type: "started" })], null),
      );

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load more events (HTTP 500)",
    );
    expect(screen.getByText("Stream created")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(
        screen.getByText("Streaming activated; linear vesting began"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the rejection message when fetch rejects with an Error", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    expect(screen.getByText("Stream created")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
  });

  it("falls back to a generic message when fetch rejects with a non-Error", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce("boom");

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Failed to load more events.",
    );
  });

  it("maps history entry types to human-readable summaries", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(
      historyResponse(
        [
          historyEntry({ id: "a", type: "started" }),
          historyEntry({ id: "b", type: "settled" }),
          historyEntry({ id: "c", type: "withdrawn", amountRaw: "120 XLM" }),
          historyEntry({ id: "d", type: "cancelled" }),
          // Types outside the known lifecycle set must not be dropped.
          historyEntry({
            id: "e",
            type: "indexed" as StreamHistoryEntry["type"],
          }),
        ],
        null,
      ),
    );

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(screen.getByText("Event: indexed")).toBeInTheDocument());
    expect(
      screen.getByText("Streaming activated; linear vesting began"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Stream settled; funds released from escrow"),
    ).toBeInTheDocument();
    expect(screen.getByText("Recipient withdrew vested funds")).toBeInTheDocument();
    expect(
      screen.getByText("Stream cancelled; escrow split between parties"),
    ).toBeInTheDocument();
    expect(screen.getByText("Recipient withdrew vested funds")).toHaveAttribute(
      "data-amount",
      "120 XLM",
    );
  });

  it("issues only one request for rapid clicks while loading", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(
      <StreamEventsClient
        streamId="stream-ada"
        initialEvents={initialEvents}
        initialNextCursor={initialCursor}
      />,
    );

    const button = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(historyResponse([], null));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
