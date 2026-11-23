/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { EventTimeline, EventTimelineSkeleton, type ContractEvent } from "./EventTimeline";

// Keep the config module from throwing during tests (no real env vars available).
jest.mock("../lib/config", () => ({
  getConfig: () => ({ network: { name: "testnet" } }),
}));

const EVENTS: ContractEvent[] = [
  {
    id: "e1",
    type: "created",
    summary: "Stream created and escrow funded",
    timestamp: "2024-11-01T09:00:00.000Z",
    txHash: "c3f8a12e4b76d09e1a23f456bc78d90e1f234a5678b9c0d1e2f3a4b5c6d7e8f9",
    ledger: 51234001,
    amount: "120 XLM",
  },
  {
    id: "e2",
    type: "paused",
    summary: "Stream paused by sender",
    timestamp: "2024-11-10T14:00:00.000Z",
    txHash: "e5b0c34a6d98f21a3c45b678de90f12a3b456c789d0e1f2a3b4c5d6e7f8a9b0c",
    ledger: 51310500,
  },
  {
    id: "e3",
    type: "withdrawn",
    summary: "Recipient withdrew vested funds",
    timestamp: "2024-11-20T14:30:00.000Z",
    txHash: "a7d2e56c8fb01a43c567d89af012b34c5d678e90f1a2b3c4d5e6f7a8b9c0d1e2",
    ledger: 51420900,
    amount: "48 XLM",
  },
];

describe("EventTimeline", () => {
  it("renders all events newest-first by default", () => {
    render(<EventTimeline events={EVENTS} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Newest (withdrawn, 2024-11-20) should appear first.
    expect(items[0]).toHaveTextContent("Recipient withdrew vested funds");
    expect(items[2]).toHaveTextContent("Stream created and escrow funded");
  });

  it("announces the visible count in a live region", () => {
    render(<EventTimeline events={EVENTS} />);

    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 3 events");
  });

  it("only renders filter chips for event types present in the data", () => {
    render(<EventTimeline events={EVENTS} />);

    const toolbar = screen.getByRole("group", { name: /filter contract events by type/i });
    expect(within(toolbar).getByRole("button", { name: /All/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /Created/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /Paused/ })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: /Withdrawn/ })).toBeInTheDocument();
    // "Settled" is not present in the data, so no chip for it.
    expect(within(toolbar).queryByRole("button", { name: /Settled/ })).not.toBeInTheDocument();
  });

  it("filters the timeline when a type chip is selected", () => {
    render(<EventTimeline events={EVENTS} />);

    fireEvent.click(screen.getByRole("button", { name: /Paused/ }));

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Stream paused by sender");
    expect(screen.getByRole("status")).toHaveTextContent("Showing 1 of 3 events");
  });

  it("marks the active filter with aria-pressed", () => {
    render(<EventTimeline events={EVENTS} />);

    const allChip = screen.getByRole("button", { name: /All/ });
    const createdChip = screen.getByRole("button", { name: /Created/ });

    expect(allChip).toHaveAttribute("aria-pressed", "true");
    expect(createdChip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(createdChip);

    expect(createdChip).toHaveAttribute("aria-pressed", "true");
    expect(allChip).toHaveAttribute("aria-pressed", "false");
  });

  it("shows 'No events yet.' when the events array is empty", () => {
    render(<EventTimeline events={[]} />);

    expect(screen.getByText(/no events yet/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("renders the skeleton without errors", () => {
    const { container } = render(<EventTimelineSkeleton />);
    expect(container.querySelector(".event-panel")).toBeInTheDocument();
  });

  describe("explorer links", () => {
    it("renders tx hashes as links pointing to the testnet explorer", () => {
      render(<EventTimeline events={EVENTS} network="testnet" />);

      const links = screen.getAllByRole("link", { name: /view transaction on explorer/i });
      expect(links.length).toBe(3);

      const firstHash = EVENTS[2].txHash!; // created event (sorted newest-first so index 2)
      expect(links[2]).toHaveAttribute(
        "href",
        `https://stellar.expert/testnet/tx/${firstHash}`,
      );
    });

    it("renders tx hashes as links pointing to the mainnet explorer", () => {
      render(<EventTimeline events={EVENTS} network="mainnet" />);

      const links = screen.getAllByRole("link", { name: /view transaction on explorer/i });
      expect(links[0]).toHaveAttribute(
        "href",
        expect.stringContaining("https://stellar.expert/tx/"),
      );
    });

    it("sets target=_blank and rel=noopener noreferrer on explorer links", () => {
      render(<EventTimeline events={EVENTS} network="testnet" />);

      const links = screen.getAllByRole("link", { name: /view transaction on explorer/i });
      links.forEach((link) => {
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      });
    });

    it("falls back to plain CopyAddress when the hash is invalid", () => {
      const eventWithBadHash: ContractEvent = {
        id: "bad",
        type: "created",
        summary: "Bad hash event",
        timestamp: "2024-11-01T09:00:00.000Z",
        txHash: "not-a-real-hash",
      };
      render(<EventTimeline events={[eventWithBadHash]} network="testnet" />);

      expect(screen.queryByRole("link", { name: /view transaction on explorer/i })).not.toBeInTheDocument();
    });

    it("falls back to plain CopyAddress for the future network (no explorer profile)", () => {
      render(<EventTimeline events={EVENTS} network="future" />);

      expect(screen.queryByRole("link", { name: /view transaction on explorer/i })).not.toBeInTheDocument();
    });

    it("uses the network from app config when no network prop is supplied", () => {
      // The mock at the top of this file returns testnet.
      render(<EventTimeline events={EVENTS} />);

      const links = screen.getAllByRole("link", { name: /view transaction on explorer/i });
      expect(links[0]).toHaveAttribute(
        "href",
        expect.stringContaining("https://stellar.expert/testnet/tx/"),
      );
    });
  });
});
