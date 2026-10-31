/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";
import ActivityPage from "./page";

// Mock the ActivityTimeline component
jest.mock("../components/ActivityTimeline", () => ({
  ActivityTimeline: ({ groups }: { groups: any[] }) => (
    <div data-testid="activity-timeline">
      {groups.map((group, i) => (
        <div key={i} data-testid="activity-group">
          <h3>{group.date}</h3>
          {group.events.map((event: any) => (
            <div key={event.id} data-testid="activity-event">
              {event.title}
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
  ActivityTimelineSkeleton: () => (
    <div data-testid="activity-skeleton">
      <div>Loading skeleton...</div>
    </div>
  ),
}));

describe("ActivityPage", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          data: [
            {
              id: "1",
              type: "stream_created",
              description: "New stream created for Project Alpha",
              timestamp: new Date().toISOString(),
              streamId: "alpha",
              isDeleted: false,
            },
            {
              id: "2",
              type: "stream_created",
              description: "Deleted stream activity",
              timestamp: new Date().toISOString(),
              streamId: "beta",
              isDeleted: true,
            }
          ]
        })
      })
    ) as jest.Mock;
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("shows the loading skeleton while data is fetching", () => {
    render(<ActivityPage />);
    expect(screen.getByTestId("activity-skeleton")).toBeInTheDocument();
    
    const feedSection = screen.getByLabelText("Activity feed");
    expect(feedSection).toHaveAttribute("aria-busy", "true");
  });

  it("renders the page heading and description", () => {
    render(<ActivityPage />);
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Track every event.")).toBeInTheDocument();
  });

  it("transitions to the populated state after load", async () => {
    render(<ActivityPage />);
    expect(screen.getByTestId("activity-skeleton")).toBeInTheDocument();
    
    await waitFor(() => {
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    });
    
    expect(screen.getByText("Today")).toBeInTheDocument();
  });

  it("uses aria-busy=true while loading", () => {
    render(<ActivityPage />);
    const feedSection = screen.getByLabelText("Activity feed");
    expect(feedSection).toHaveAttribute("aria-busy", "true");
  });

  it("clears aria-busy once data is loaded", async () => {
    render(<ActivityPage />);
    
    await waitFor(() => {
      const feedSection = screen.getByLabelText("Activity feed");
      expect(feedSection).toHaveAttribute("aria-busy", "false");
    });
  });

  // ── Scenario 1: Activity loads 3 groups ────────────────────────────────────
  it("announces 'Loaded N events' in exactly one live region and no container has aria-live", async () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "ev1",
            type: "stream_created",
            description: "Event today",
            timestamp: today.toISOString(),
          },
          {
            id: "ev2",
            type: "wallet_connected",
            description: "Event yesterday",
            timestamp: yesterday.toISOString(),
          },
          {
            id: "ev3",
            type: "funds_withdrawn",
            description: "Event 2 days ago",
            timestamp: twoDaysAgo.toISOString(),
          },
        ],
      }),
    });

    const { container } = render(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    });

    // Exactly one live region announcing success with count
    const statusRegions = screen.getAllByRole("status");
    expect(statusRegions).toHaveLength(1);
    expect(statusRegions[0]).toHaveTextContent("Loaded 3 events");
    expect(statusRegions[0]).toHaveAttribute("aria-live", "polite");

    // No content container has aria-live
    const liveSections = container.querySelectorAll("section[aria-live]");
    expect(liveSections).toHaveLength(0);
    const liveContainers = container.querySelectorAll("[aria-live]:not(.sr-only)");
    expect(liveContainers).toHaveLength(0);
  });

  // ── Scenario 2: Activity fetch fails ───────────────────────────────────────
  it("announces error message in an assertive live region when fetch fails", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Unable to connect to server"));

    render(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByTestId("activity-live-region")).toHaveTextContent("Unable to connect to server");
    });

    const alertRegion = screen.getByTestId("activity-live-region");
    expect(alertRegion).toHaveAttribute("aria-live", "assertive");
    expect(alertRegion).toHaveTextContent("Unable to connect to server");
  });

  // ── Scenario 6: The DOM has only one role='status' per page ───────────────
  it("has only one role=status in the DOM in both loading and populated states", async () => {
    // 1. Loading state
    global.fetch = jest.fn(() => new Promise(() => {}));
    const { unmount } = render(<ActivityPage />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading activity…");
    unmount();

    // 2. Populated state
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "ev1",
            type: "stream_created",
            description: "Event 1",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    render(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    });

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loaded 1 event");
  });

  // ── Scenario 7: axe on both pages in each state ───────────────────────────
  it("has no serious or critical axe violations in loading, populated, empty, and error states", async () => {
    // State 1: Loading
    global.fetch = jest.fn(() => new Promise(() => {}));
    const { container, unmount } = render(<ActivityPage />);
    jest.useRealTimers();
    expect(await axe(container)).toHaveNoViolations();
    jest.useFakeTimers();
    unmount();

    // State 2: Populated
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "ev1",
            type: "stream_created",
            description: "Event 1",
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    const populatedRender = render(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    });
    jest.useRealTimers();
    expect(await axe(populatedRender.container)).toHaveNoViolations();
    jest.useFakeTimers();
    populatedRender.unmount();

    // State 3: Empty
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const emptyRender = render(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText("Activity will appear here")).toBeInTheDocument();
    });
    jest.useRealTimers();
    expect(await axe(emptyRender.container)).toHaveNoViolations();
    jest.useFakeTimers();
    emptyRender.unmount();

    // State 4: Error
    global.fetch = jest.fn().mockRejectedValue(new Error("Connection error"));
    const errorRender = render(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText("Couldn't load your activity")).toBeInTheDocument();
    });
    jest.useRealTimers();
    expect(await axe(errorRender.container)).toHaveNoViolations();
    jest.useFakeTimers();
    errorRender.unmount();
  });
});
