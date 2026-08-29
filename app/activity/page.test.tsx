/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react";
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
});
