/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { StreamsPageContent, mockStreams } from "./StreamsPageContent";

// Mock the StreamRow component
jest.mock("../components/StreamRow", () => ({
  StreamRow: ({ stream, density }: { stream: any; density?: string }) => (
    <div data-testid="stream-row" data-density={density ?? "comfortable"}>
      <span>{stream.recipient}</span>
      <span>{stream.rate}</span>
      <span>{stream.status}</span>
    </div>
  ),
}));

describe("StreamsPageContent", () => {
  it("shows loading state with the custom StreamListSkeleton", () => {
    render(<StreamsPageContent state="loading" streams={[]} />);

    // Skeleton CSS class nodes (Skeleton component emits .skeleton)
    expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    // role="status" polite announcement is present (label text matches)
    expect(screen.getByText(/Loading your streams/i)).toBeInTheDocument();
    // 3 ghost row articles rendered inside the skeleton
    expect(
      document.querySelectorAll("article.stream-row--skeleton").length,
    ).toBe(3);
  });

  it("shows populated state with streams", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    expect(screen.getByText("Ada Creative Studio")).toBeInTheDocument();
    expect(screen.getByText("Kemi Onboarding Support")).toBeInTheDocument();
    expect(screen.getByText("Yusuf QA Partnership")).toBeInTheDocument();

    // Dynamic count (matches the actual streams[] length)
    expect(screen.getByText("3 active records")).toBeInTheDocument();
  });

  it("renders correct singular count when there is exactly 1 stream", () => {
    render(
      <StreamsPageContent state="populated" streams={[mockStreams[0]!]} />,
    );
    expect(screen.getByText("1 active record")).toBeInTheDocument();
  });

  describe("empty state", () => {
    it("shows copy, primary CTA and the v7 EmptyIllustration SVG when explicitly state=empty", () => {
      render(<StreamsPageContent state="empty" streams={[]} />);

      // Primary copy matches streamListCopy.empty
      expect(screen.getAllByText(/Streams/i)[0]).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /Your streams list is empty/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Create Your First Stream/i }),
      ).toBeInTheDocument();

      // v7 EmptyIllustration is rendered (inside .empty-state__illustration > svg)
      const illustWrap = document.querySelector(".empty-state__illustration");
      expect(illustWrap).not.toBeNull();
      expect(illustWrap?.querySelector("svg")).not.toBeNull();
    });

    it("auto-detects empty when state prop is omitted and streams=[]", () => {
      render(<StreamsPageContent streams={[]} />);
      expect(
        screen.getByRole("heading", { name: /Your streams list is empty/i }),
      ).toBeInTheDocument();
    });

    it("renders the guidanceSteps bullets under the illustration", () => {
      render(<StreamsPageContent state="empty" streams={[]} />);
      const list = document.querySelector(".empty-state__supporting-list");
      expect(list).not.toBeNull();
      const bullets = list!.querySelectorAll("li");
      expect(bullets.length).toBeGreaterThanOrEqual(3);
    });

    it("binds onRetryAction into the EmptyState action CTA", () => {
      const onCreate = jest.fn();
      render(
        <StreamsPageContent
          state="empty"
          streams={[]}
          onRetryAction={onCreate}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Create Your First Stream/i }),
      );
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
  });

  it("shows error state with retry handler", () => {
    const onRetry = jest.fn();
    render(
      <StreamsPageContent
        state="error"
        streams={[]}
        errorMessage="Custom error message"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Couldn't load your streams")).toBeInTheDocument();
    expect(screen.getByText("Custom error message")).toBeInTheDocument();
    const retryBtn = screen.getByRole("button", { name: /try again/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the page header with title and description", () => {
    render(<StreamsPageContent state="populated" streams={mockStreams} />);

    expect(
      screen.getByText("Manage every stream from one list."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Track recipients, rates, statuses, and the next action from one scan-friendly streams list./i,
      ),
    ).toBeInTheDocument();
  });

  it("shows Export History + Create Stream action buttons in the hero and wires Create to onRetryAction", () => {
    const onCreate = jest.fn();
    render(
      <StreamsPageContent
        state="populated"
        streams={mockStreams}
        onRetryAction={onCreate}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Export History" }),
    ).toBeInTheDocument();
    const createBtn = screen.getByRole("button", { name: "Create Stream" });
    expect(createBtn).toBeInTheDocument();

    // "Create Stream" hero button is wired to onRetryAction prop
    fireEvent.click(createBtn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  describe("density toggle", () => {
    it("renders the density toggle with comfortable initial state", () => {
      render(<StreamsPageContent state="populated" streams={mockStreams} />);
      const cozyBtn = screen.getByRole("radio", { name: "Cozy" });
      expect(cozyBtn).toBeInTheDocument();
      expect(cozyBtn).toHaveAttribute("aria-checked", "true");
    });

    it("toggles density to compact on click and forwards it to StreamRow", () => {
      render(<StreamsPageContent state="populated" streams={mockStreams} />);
      const compactBtn = screen.getByRole("radio", { name: "Compact" });

      fireEvent.click(compactBtn);
      expect(compactBtn).toHaveAttribute("aria-checked", "true");

      const rows = screen.getAllByTestId("stream-row");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) =>
        expect(row).toHaveAttribute("data-density", "compact"),
      );
    });

    it("honours initialDensity=compact", () => {
      render(
        <StreamsPageContent
          state="populated"
          streams={mockStreams}
          initialDensity="compact"
        />,
      );
      const compactBtn = screen.getByRole("radio", { name: "Compact" });
      expect(compactBtn).toHaveAttribute("aria-checked", "true");
    });
  });
});
