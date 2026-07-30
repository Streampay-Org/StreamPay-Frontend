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
  });

  afterEach(() => {
    jest.useRealTimers();
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
    
    jest.advanceTimersByTime(1500);
    
    await waitFor(() => {
      expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    });
    
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("uses aria-busy=true while loading", () => {
    render(<ActivityPage />);
    const feedSection = screen.getByLabelText("Activity feed");
    expect(feedSection).toHaveAttribute("aria-busy", "true");
  });

  it("clears aria-busy once data is loaded", async () => {
    render(<ActivityPage />);
    jest.advanceTimersByTime(1500);
    
    await waitFor(() => {
      const feedSection = screen.getByLabelText("Activity feed");
      expect(feedSection).toHaveAttribute("aria-busy", "false");
    });
  });
});
