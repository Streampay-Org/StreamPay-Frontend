/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StreamRow, type StreamRowData } from "./StreamRow";
import type { StreamStatus } from "@/app/types/openapi";

jest.mock("../../lib/apiClient", () => ({
  fetchWithIdempotency: jest.fn().mockResolvedValue({ ok: true }),
}));

const ALL_STATUSES: readonly StreamStatus[] = [
  "active",
  "draft",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const;

function makeMockStream(status: StreamStatus): StreamRowData {
  const nextByStatus: Record<StreamStatus, string> = {
    active: "Pause",
    draft: "Start",
    paused: "Resume",
    ended: "Settle",
    withdrawn: "Details",
    cancelled: "Details",
  };
  return {
    id: `stream-${status}`,
    nextAction: nextByStatus[status],
    rate: "100 XLM / month",
    recipient: `Recipient ${status}`,
    schedule: "Pays every month",
    status,
    accruedAmount: 500,
    totalAmount: 1000,
  };
}

const baseStream: StreamRowData = makeMockStream("active");

describe("StreamRow", () => {
  it("renders correctly and contains the recipient and action button", () => {
    render(<StreamRow stream={baseStream} />);
    expect(screen.getByText("Recipient active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("lets the action button receive focus without inline focus styling", () => {
    render(<StreamRow stream={baseStream} />);
    const actionButton = screen.getByRole("button", { name: "Pause" });

    expect(actionButton).not.toHaveAttribute("style");

    actionButton.focus();

    expect(actionButton).toHaveFocus();
    expect(actionButton).not.toHaveAttribute("style");
  });

  describe("color-blind safe pattern overlay (v7)", () => {
    it.each(ALL_STATUSES)("renders the decorative pattern overlay div for status=%s", (status) => {
      const { container } = render(<StreamRow stream={makeMockStream(status)} />);
      const pattern = container.querySelector(".stream-row__pattern");

      expect(pattern).not.toBeNull();
      // Decorative only — must be hidden from assistive tech
      expect(pattern).toHaveAttribute("aria-hidden", "true");
    });

    it.each(ALL_STATUSES)(
      "applies the stream-row--%s BEM modifier so the pattern CSS selector activates",
      (status) => {
        const { container } = render(<StreamRow stream={makeMockStream(status)} />);
        const article = container.querySelector("article.stream-row");

        expect(article).toHaveClass(`stream-row--${status}`);
        expect(article).toHaveAttribute("data-status", status);
      }
    );

    it("applies the stream-row__pattern child element (texture fill) for active", () => {
      const { container } = render(<StreamRow stream={makeMockStream("active")} />);
      const pattern = container.querySelector(".stream-row__pattern");
      expect(pattern?.classList.contains("stream-row__pattern")).toBe(true);
    });

    it("renders StatusBadge inside the row with pattern classes applied internally", () => {
      const { container } = render(<StreamRow stream={makeMockStream("active")} />);
      const badge = container.querySelector(".status-badge");
      expect(badge).not.toBeNull();
      // StatusBadge now auto-applies cb-pattern classes (see StatusBadge tests)
      expect(badge).toHaveClass("cb-pattern");
      expect(badge).toHaveClass("cb-pattern--active");
    });

    it("renders withdrawn with the same terminal pattern class as ended", () => {
      const { container } = render(<StreamRow stream={makeMockStream("withdrawn")} />);
      const badge = container.querySelector(".status-badge");
      expect(badge).toHaveClass("cb-pattern--ended");
    });

    it("renders cancelled with its distinct reverse-diagonal pattern", () => {
      const { container } = render(<StreamRow stream={makeMockStream("cancelled")} />);
      const badge = container.querySelector(".status-badge");
      expect(badge).toHaveClass("cb-pattern--cancelled");
    });
  });

  describe("data-status attribute (pattern selector & e2e hook)", () => {
    it.each(ALL_STATUSES)("sets data-status=%s on the <article> element", (status) => {
      const { container } = render(<StreamRow stream={makeMockStream(status)} />);
      const article = container.querySelector("article.stream-row");
      expect(article?.getAttribute("data-status")).toBe(status);
    });
  });

  describe("keyboard shortcut hint", () => {
    it("renders a kbd hint in the action area", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const hint = container.querySelector("[data-testid='kbd-hint']");
      expect(hint).not.toBeNull();
    });

    it("renders Enter as the shortcut key", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const kbd = container.querySelector("[data-testid='kbd-hint'] kbd");
      expect(kbd).toHaveTextContent("Enter");
    });

    it("hides the hint from assistive tech", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const hint = container.querySelector("[data-testid='kbd-hint']");
      expect(hint).toHaveAttribute("aria-hidden", "true");
    });

    it.each(ALL_STATUSES)("renders kbd hint for status=%s", (status) => {
      const { container } = render(<StreamRow stream={makeMockStream(status)} />);
      expect(container.querySelector("[data-testid='kbd-hint']")).not.toBeNull();
    });
  });

  describe("compact density variant", () => {
    it("applies stream-row--compact modifier when density=compact", () => {
      const { container } = render(
        <StreamRow stream={makeMockStream("paused")} density="compact" />
      );
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveClass("stream-row--compact");
      // Pattern overlay still renders in compact mode
      expect(container.querySelector(".stream-row__pattern")).not.toBeNull();
    });
  });

  describe("tabular-nums font variant formatting (FWC26 Stellar Wave)", () => {
    it("applies tabular-nums class to the Rate numeric display element", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const rateDd = container.querySelector("dd.tabular-nums");
      expect(rateDd).not.toBeNull();
      expect(rateDd).toHaveTextContent(baseStream.rate);
    });

    it("applies tabular-nums class to the Burn-down container when amounts are present", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const burndownDd = container.querySelector(".stream-row__burndown");
      expect(burndownDd).not.toBeNull();
      expect(burndownDd).toHaveClass("tabular-nums");
    });

    it("applies tabular-nums class to the remaining stream progress label", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const remainingSpan = container.querySelector(".stream-progress__remaining");
      expect(remainingSpan).not.toBeNull();
      expect(remainingSpan).toHaveClass("tabular-nums");
    });
  });

  describe("per-stream color stripe identity", () => {
    it("renders the color stripe element", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const stripe = container.querySelector(".stream-row__color-stripe");
      expect(stripe).not.toBeNull();
    });

    it("applies aria-hidden to the color stripe", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const stripe = container.querySelector(".stream-row__color-stripe");
      expect(stripe).toHaveAttribute("aria-hidden", "true");
    });

    it("sets a deterministic background color based on stream ID", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const stripe = container.querySelector(".stream-row__color-stripe") as HTMLElement;
      const style = stripe.getAttribute("style") || "";
      expect(style).toContain("background-color:");
    });

    it("produces the same color for the same stream ID", () => {
      const { container: container1 } = render(<StreamRow stream={baseStream} />);
      const { container: container2 } = render(<StreamRow stream={baseStream} />);
      const stripe1 = container1.querySelector(".stream-row__color-stripe") as HTMLElement;
      const stripe2 = container2.querySelector(".stream-row__color-stripe") as HTMLElement;
      expect(stripe1.getAttribute("style")).toBe(stripe2.getAttribute("style"));
    });

    it("produces different colors for different stream IDs", () => {
      const stream1 = makeMockStream("active");
      const stream2 = makeMockStream("draft");
      const { container: container1 } = render(<StreamRow stream={stream1} />);
      const { container: container2 } = render(<StreamRow stream={stream2} />);
      const stripe1 = container1.querySelector(".stream-row__color-stripe") as HTMLElement;
      const stripe2 = container2.querySelector(".stream-row__color-stripe") as HTMLElement;
      expect(stripe1.getAttribute("style")).not.toBe(stripe2.getAttribute("style"));
    });

    it.each(ALL_STATUSES)("renders color stripe for status=%s", (status) => {
      const { container } = render(<StreamRow stream={makeMockStream(status)} />);
      const stripe = container.querySelector(".stream-row__color-stripe");
      expect(stripe).not.toBeNull();
      expect(stripe).toHaveAttribute("aria-hidden", "true");
    });
  });

  // ── matchMedia mock ─────────────────────────────────────────────────────────

  /** Installs a matchMedia mock that reports the given reduced-motion preference. */
  function mockMatchMedia(prefersReduced: boolean) {
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? prefersReduced : false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
  }

  describe("reduced-motion fallback (Issue #1038)", () => {
    afterEach(() => {
      // @ts-expect-error reset between tests
      delete window.matchMedia;
    });

    it("sets data-reduced-motion=false on the article element by default", () => {
      mockMatchMedia(false);
      const { container } = render(<StreamRow stream={baseStream} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveAttribute("data-reduced-motion", "false");
    });

    it("sets data-reduced-motion=true when prefers-reduced-motion is active", () => {
      mockMatchMedia(true);
      const { container } = render(<StreamRow stream={baseStream} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveAttribute("data-reduced-motion", "true");
    });

    it("sets data-reduced-motion on the cancel-reveal element", () => {
      mockMatchMedia(true);
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const reveal = container.querySelector(".stream-row__cancel-reveal");
      expect(reveal).toHaveAttribute("data-reduced-motion", "true");
    });

    it("sets data-reduced-motion on the cancel-reveal to false by default", () => {
      mockMatchMedia(false);
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const reveal = container.querySelector(".stream-row__cancel-reveal");
      expect(reveal).toHaveAttribute("data-reduced-motion", "false");
    });
  });
});
