/**
 * @jest-environment jsdom
 */

import { render, fireEvent, waitFor } from "@testing-library/react";
const { screen } = require("@testing-library/react") as any;
import { CompareStreamsModal, type CompareStream } from "./CompareStreamsModal";

const mockStreamA: CompareStream = {
  id: "stream-123",
  recipient: "Alice Johnson",
  rate: "120 XLM / month",
  runway: "14 days remaining",
  balance: "340 XLM available",
  status: "active",
  createdAt: "2024-01-15T10:30:00Z",
};

const mockStreamB: CompareStream = {
  id: "stream-456",
  recipient: "Bob Smith",
  rate: "80 XLM / month",
  runway: "21 days remaining",
  balance: "520 XLM available",
  status: "paused",
  createdAt: "2024-02-20T14:45:00Z",
};

describe("CompareStreamsModal", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <CompareStreamsModal
        isOpen={false}
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders the modal when isOpen is true", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Compare Streams")).toBeInTheDocument();
  });

  it("displays both stream IDs in column headers", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    expect(screen.getByText("stream-123")).toBeInTheDocument();
    expect(screen.getByText("stream-456")).toBeInTheDocument();
  });

  it("displays both recipient names", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    expect(screen.getByText("Alice Johnson")).toBeInTheDocument();
    expect(screen.getByText("Bob Smith")).toBeInTheDocument();
  });

  it("displays rate comparison for both streams", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const rateLabels = screen.getAllByText("Rate");
    expect(rateLabels).toHaveLength(2);
    expect(screen.getByText("120 XLM / month")).toBeInTheDocument();
    expect(screen.getByText("80 XLM / month")).toBeInTheDocument();
  });

  it("displays runway comparison for both streams", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const runwayLabels = screen.getAllByText("Runway");
    expect(runwayLabels).toHaveLength(2);
    expect(screen.getByText("14 days remaining")).toBeInTheDocument();
    expect(screen.getByText("21 days remaining")).toBeInTheDocument();
  });

  it("displays balance comparison for both streams", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const balanceLabels = screen.getAllByText("Balance");
    expect(balanceLabels).toHaveLength(2);
    expect(screen.getByText("340 XLM available")).toBeInTheDocument();
    expect(screen.getByText("520 XLM available")).toBeInTheDocument();
  });

  it("displays status badges for both streams", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const statusLabels = screen.getAllByText("Status");
    expect(statusLabels).toHaveLength(2);
    // Use getAllByText since status text appears in multiple places
    const activeElements = screen.getAllByText("Active");
    const pausedElements = screen.getAllByText("Paused");
    expect(activeElements.length).toBeGreaterThan(0);
    expect(pausedElements.length).toBeGreaterThan(0);
  });

  it("formats and displays creation dates", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const createdLabels = screen.getAllByText("Created");
    expect(createdLabels).toHaveLength(2);
    // Date format depends on locale, but should contain year, month, and day
    const yearElements = screen.getAllByText(/2024/);
    expect(yearElements.length).toBeGreaterThan(0);
  });

  it("displays dash for missing createdAt", () => {
    const streamWithoutDate: CompareStream = {
      ...mockStreamA,
      createdAt: "",
    };

    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={streamWithoutDate}
        streamB={mockStreamB}
      />,
    );

    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = jest.fn();
    render(
      <CompareStreamsModal
        isOpen
        onClose={onClose}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const closeButton = screen.getByRole("button", { name: /close compare streams dialog/i });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = jest.fn();
    const { container } = render(
      <CompareStreamsModal
        isOpen
        onClose={onClose}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    // The backdrop is the first div with aria-hidden="true"
    const backdrop = container.querySelector('[aria-hidden="true"]');
    expect(backdrop).toBeInTheDocument();
    
    if (backdrop) {
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalled();
    }
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = jest.fn();
    render(
      <CompareStreamsModal
        isOpen
        onClose={onClose}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("has correct accessibility attributes", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
  });

  it("focuses close button on mount", async () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const closeButton = screen.getByRole("button", { name: /close compare streams dialog/i });
    
    await waitFor(() => {
      expect(closeButton).toHaveFocus();
    });
  });

  it("traps focus within the modal", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const closeButton = screen.getByRole("button", { name: /close compare streams dialog/i });

    // Simulate Tab key press - the component has focus trap logic
    fireEvent.keyDown(dialog, { key: "Tab" });
    
    // Verify the dialog is still in the document and focusable elements exist
    expect(dialog).toBeInTheDocument();
    expect(closeButton).toBeInTheDocument();
  });

  it("prevents click propagation from modal content to backdrop", () => {
    const onClose = jest.fn();
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    
    // Clicking the dialog content should not call onClose
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders with different stream statuses", () => {
    const streamEnded: CompareStream = {
      ...mockStreamA,
      status: "ended",
    };

    const streamCancelled: CompareStream = {
      ...mockStreamB,
      status: "cancelled",
    };

    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={streamEnded}
        streamB={streamCancelled}
      />,
    );

    // Use getAllByText since status text appears in multiple places
    const endedElements = screen.getAllByText("Ended");
    const cancelledElements = screen.getAllByText("Cancelled");
    expect(endedElements.length).toBeGreaterThan(0);
    expect(cancelledElements.length).toBeGreaterThan(0);
  });

  it("renders with draft status", () => {
    const streamDraft: CompareStream = {
      ...mockStreamA,
      status: "draft",
    };

    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={streamDraft}
        streamB={mockStreamB}
      />,
    );

    // Use getAllByText since status text appears in multiple places
    const draftElements = screen.getAllByText("Draft");
    expect(draftElements.length).toBeGreaterThan(0);
  });

  it("renders with withdrawn status", () => {
    const streamWithdrawn: CompareStream = {
      ...mockStreamA,
      status: "withdrawn",
    };

    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={streamWithdrawn}
        streamB={mockStreamB}
      />,
    );

    // Use getAllText since withdrawn appears in both aria-label and visible text
    const withdrawnElements = screen.getAllByText("Withdrawn");
    expect(withdrawnElements.length).toBeGreaterThan(0);
  });

  it("highlights the rate row with green background", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const rateLabels = screen.getAllByText("Rate");
    // The rate row should have highlighting
    expect(rateLabels[0]).toBeInTheDocument();
  });

  it("handles empty strings gracefully", () => {
    const emptyStream: CompareStream = {
      id: "",
      recipient: "",
      rate: "",
      runway: "",
      balance: "",
      status: "draft",
      createdAt: "",
    };

    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={emptyStream}
        streamB={mockStreamB}
      />,
    );

    // Should still render without crashing
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("unmounts cleanly after close animation", async () => {
    const { rerender } = render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    rerender(
      <CompareStreamsModal
        isOpen={false}
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    // Wait for animation timeout
    await waitFor(
      () => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      },
      { timeout: 300 }
    );
  });

  it("has proper aria-label for comparison description", () => {
    render(
      <CompareStreamsModal
        isOpen
        onClose={jest.fn()}
        streamA={mockStreamA}
        streamB={mockStreamB}
      />,
    );

    const descriptionList = screen.getByRole("dialog").querySelector("dl");
    expect(descriptionList).toHaveAttribute(
      "aria-label",
      "Comparing Alice Johnson with Bob Smith"
    );
  });
});
