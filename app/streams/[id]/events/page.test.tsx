/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import StreamEventsPage from "./page";
import { notFound } from "next/navigation";
import { getStore, resetDb } from "@/app/lib/db";

// Mock next/navigation
jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

beforeEach(() => {
  resetDb();
  jest.clearAllMocks();
});

describe("StreamEventsPage (contract events panel)", () => {
  it("renders the contract events panel for stream-ada with no events yet", async () => {
    const params = Promise.resolve({ id: "stream-ada" });
    const jsx = await StreamEventsPage({ params });
    render(jsx);

    // Page structure
    expect(screen.getByRole("heading", { name: /contract events/i })).toBeInTheDocument();
    // Display label comes from stream.recipient in the seeded fixture
    expect(screen.getByText("Ada Creative Studio")).toBeInTheDocument();

    // Filter toolbar is present
    expect(
      screen.getByRole("group", { name: /filter contract events by type/i }),
    ).toBeInTheDocument();

    // Empty state — no history events seeded for this stream
    expect(screen.getByTestId("events-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("events-empty-state")).toHaveTextContent("No events yet.");
  });

  it("renders timeline events when history entries exist", async () => {
    // Seed some history entries for stream-ada
    const store = getStore();
    store.streamHistory.append({
      id: "e1",
      streamId: "stream-ada",
      type: "created",
      toStatus: "draft",
      at: "2026-06-01T09:00:00.000Z",
    });
    store.streamHistory.append({
      id: "e2",
      streamId: "stream-ada",
      type: "paused",
      fromStatus: "active",
      toStatus: "paused",
      at: "2026-06-01T10:00:00.000Z",
    });

    const params = Promise.resolve({ id: "stream-ada" });
    const jsx = await StreamEventsPage({ params });
    render(jsx);

    // Both event summaries should be visible
    expect(screen.getByText("Stream created")).toBeInTheDocument();
    expect(screen.getByText("Stream paused; accrual frozen")).toBeInTheDocument();

    // Status count
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 of 2 events");
  });

  it("links back to the parent stream detail page", async () => {
    const params = Promise.resolve({ id: "stream-ada" });
    const jsx = await StreamEventsPage({ params });
    render(jsx);

    const backLink = screen.getByRole("link", { name: /back to stream/i });
    expect(backLink).toHaveAttribute("href", "/streams/stream-ada");
  });

  it("calls notFound() for an unknown stream id", async () => {
    const params = Promise.resolve({ id: "does-not-exist" });
    await StreamEventsPage({ params });
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
