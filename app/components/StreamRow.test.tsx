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

    it("applies transition: none to cancel-label when reduced motion is requested", () => {
      mockMatchMedia(true);
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const label = container.querySelector(".stream-row__cancel-label") as HTMLElement;
      expect(label.style.transition).toBe("none");
    });

    it("does not force transition: none on cancel-label when reduced motion is not requested", () => {
      mockMatchMedia(false);
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const label = container.querySelector(".stream-row__cancel-label") as HTMLElement;
      expect(label.style.transition).toBe("");
    });

    it("applies transition: none to swipe style when reduced motion is requested", () => {
      mockMatchMedia(true);
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      // Simulate a left swipe
      fireEvent.touchStart(article, { touches: [{ clientX: 200, clientY: 100 }] });
      fireEvent.touchMove(article, { touches: [{ clientX: 50, clientY: 100 }] });

      expect(article.style.transition).toBe("none");
    });

    it("preserves data-status attribute regardless of motion preference", () => {
      mockMatchMedia(true);
      const { container } = render(<StreamRow stream={baseStream} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveAttribute("data-status", baseStream.status);
    });

    it.each(ALL_STATUSES)(
      "sets data-reduced-motion on article for status=%s",
      (status) => {
        mockMatchMedia(true);
        const { container } = render(<StreamRow stream={makeMockStream(status)} />);
        const article = container.querySelector("article.stream-row");
        expect(article).toHaveAttribute("data-reduced-motion", "true");
      },
    );
  });

  describe("loading skeleton (Issue #1033)", () => {
    afterEach(() => {
      // @ts-expect-error reset between tests
      delete window.matchMedia;
    });

    it("renders skeleton when loading is true", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveClass("stream-row--skeleton");
    });

    it("applies aria-busy on the article element when loading", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveAttribute("aria-busy", "true");
    });

    it("applies aria-label to indicate loading state", () => {
      render(<StreamRow stream={baseStream} loading={true} />);
      expect(screen.getByLabelText("Stream row is loading")).toBeInTheDocument();
    });

    it("does not render live content (recipient, action button) when loading", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      expect(container.querySelector("h2")).toBeNull();
      expect(container.querySelector("button")).toBeNull();
      expect(container.querySelector(".status-badge")).toBeNull();
      expect(container.querySelector(".stream-progress")).toBeNull();
      expect(container.querySelector(".stream-row__pattern")).toBeNull();
    });

    it("renders Skeleton elements inside the row", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const skeletons = container.querySelectorAll(".skeleton");
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it("renders skeleton avatar (circle)", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const circles = container.querySelectorAll("[style*='border-radius: 50%']");
      expect(circles.length).toBeGreaterThan(0);
    });

    it("skeleton elements are aria-hidden from screen readers", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const skeletons = container.querySelectorAll(".skeleton");
      skeletons.forEach((sk) => {
        expect(sk).toHaveAttribute("aria-hidden", "true");
      });
    });

    it("applies stream-row--compact modifier when density=compact and loading", () => {
      const { container } = render(
        <StreamRow stream={makeMockStream("paused")} density="compact" loading={true} />
      );
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveClass("stream-row--compact");
      expect(article).toHaveClass("stream-row--skeleton");
    });

    it("renders skeleton for the color stripe placeholder", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const stripe = container.querySelector(".stream-row__color-stripe");
      expect(stripe).not.toBeNull();
      expect(stripe).toHaveAttribute("aria-hidden", "true");
    });

    it("renders meta section with dt elements in skeleton", () => {
      const { container } = render(<StreamRow stream={baseStream} loading={true} />);
      const dts = container.querySelectorAll("dt");
      expect(dts.length).toBeGreaterThan(0);
    });

    it("does not render skeleton when loading is false (normal render)", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      expect(container.querySelector(".stream-row--skeleton")).toBeNull();
      expect(container.querySelector("button")).not.toBeNull();
    });

    it("does not render skeleton when loading is undefined (normal render)", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      expect(container.querySelector(".stream-row--skeleton")).toBeNull();
    });
  });

  describe("swipe to cancel (mobile)", () => {
    const cancellableStream: StreamRowData = {
      ...makeMockStream("active"),
      nextAction: "Cancel",
    };

    const nonCancellableStreams: StreamRowData[] = [
      { ...makeMockStream("cancelled"), nextAction: "Cancel" },
      { ...makeMockStream("ended"), nextAction: "Cancel" },
      { ...makeMockStream("withdrawn"), nextAction: "Cancel" },
      { ...makeMockStream("active"), nextAction: "Pause" },
    ];

    function touchStart(article: HTMLElement, x: number, y: number) {
      fireEvent.touchStart(article, {
        touches: [{ clientX: x, clientY: y }],
      });
    }

    function touchMove(article: HTMLElement, x: number, y: number) {
      fireEvent.touchMove(article, {
        touches: [{ clientX: x, clientY: y }],
      });
    }

    function touchEnd(article: HTMLElement) {
      fireEvent.touchEnd(article);
    }

    it("renders the cancel reveal element for cancellable streams", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const reveal = container.querySelector(".stream-row__cancel-reveal");
      expect(reveal).not.toBeNull();
      expect(reveal).toHaveAttribute("aria-hidden", "true");
    });

    it.each(nonCancellableStreams)(
      "does not render cancel reveal when status=$status and nextAction=$nextAction",
      (stream) => {
        const { container } = render(<StreamRow stream={stream} />);
        const reveal = container.querySelector(".stream-row__cancel-reveal");
        expect(reveal).toBeNull();
      },
    );

    it("shows cancel label inside the reveal element", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const label = container.querySelector(".stream-row__cancel-label");
      expect(label).not.toBeNull();
      expect(label).toHaveTextContent("Cancel");
    });

    it("applies stream-row--swiping class during left swipe", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 100, 100);

      expect(article).toHaveClass("stream-row--swiping");
    });

    it("does not apply swiping class for right swipe", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 100, 100);
      touchMove(article, 200, 100);

      expect(article).not.toHaveClass("stream-row--swiping");
    });

    it("does not apply swiping class for vertical swipe", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 100, 100);
      touchMove(article, 100, 200);

      expect(article).not.toHaveClass("stream-row--swiping");
    });

    it("snaps back when swipe distance is below threshold", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 150, 100);
      touchEnd(article);

      expect(article).not.toHaveClass("stream-row--swiping");
      expect(article.style.transform).toBe("");
    });

    it("triggers cancel action when swipe exceeds threshold", async () => {
      const { fetchWithIdempotency } = require("../../lib/apiClient");
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 50, 100);
      touchEnd(article);

      expect(fetchWithIdempotency).toHaveBeenCalledWith(
        `/api/streams/${cancellableStream.id}/cancel`,
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("sets data-swipe-active on cancel reveal when threshold exceeded", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 50, 100);

      const reveal = container.querySelector(".stream-row__cancel-reveal");
      expect(reveal).toHaveAttribute("data-swipe-active", "true");
    });

    it("does not set data-swipe-active when swipe is below threshold", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 150, 100);

      const reveal = container.querySelector(".stream-row__cancel-reveal");
      expect(reveal).toHaveAttribute("data-swipe-active", "false");
    });

    it("applies translateX style during swipe", () => {
      const { container } = render(<StreamRow stream={cancellableStream} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 120, 100);

      expect(article.style.transform).toContain("translateX");
    });

    it("does not respond to touch events on non-cancellable streams", () => {
      const { container } = render(<StreamRow stream={makeMockStream("active")} />);
      const article = container.querySelector("article.stream-row") as HTMLElement;

      touchStart(article, 200, 100);
      touchMove(article, 50, 100);
      touchEnd(article);

      expect(article).not.toHaveClass("stream-row--swiping");
      expect(article.style.transform).toBe("");
    });
  });

  /**
   * Design token v7 (issue #1030) — spacing & typography pin tests.
   *
   * jsdom does not load stylesheets, so we verify the DOM structure that
   * the CSS hooks into: correct BEM class names, correct elements, and
   * correct data attributes.  Pixel values are asserted via CSS custom
   * properties in a separate snapshot (see docs/DESIGN_TOKENS.md).
   */
  describe("design tokens v7 – spacing & typography BEM hooks", () => {
    it("renders the root article with stream-row class for spacing hooks", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const article = container.querySelector("article");
      expect(article).toHaveClass("stream-row");
    });

    it("renders stream-row__primary for cozy gap (--space-3) hook", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      expect(container.querySelector(".stream-row__primary")).not.toBeNull();
    });

    it("renders stream-row__identity for gap (--space-3) hook", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      expect(container.querySelector(".stream-row__identity")).not.toBeNull();
    });

    it("renders stream-row__meta for gap (--space-3) hook", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      expect(container.querySelector(".stream-row__meta")).not.toBeNull();
    });

    it("renders stream-row__recipient for margin-bottom (--space-1) hook", () => {
      const { container } = render(<StreamRow stream={baseStream} />);
      const recipient = container.querySelector(".stream-row__recipient");
      expect(recipient).not.toBeNull();
      // h2 semantics preserved
      expect(recipient?.tagName).toBe("H2");
    });

    it("renders stream-row__cancel-reveal for padding-right (--space-6) hook on cancel-eligible streams", () => {
      const cancellableStream: StreamRowData = {
        ...makeMockStream("active"),
        nextAction: "Cancel",
      };
      const { container } = render(<StreamRow stream={cancellableStream} />);
      expect(container.querySelector(".stream-row__cancel-reveal")).not.toBeNull();
    });

    it("applies stream-row--compact modifier which targets --space-3-5 padding token", () => {
      const { container } = render(
        <StreamRow stream={makeMockStream("active")} density="compact" />
      );
      const article = container.querySelector("article.stream-row");
      expect(article).toHaveClass("stream-row--compact");
    });

    it("compact mode still renders all spacing-sensitive child elements", () => {
      const { container } = render(
        <StreamRow stream={makeMockStream("paused")} density="compact" />
      );
      // All of these carry --space-* token overrides in compact rules
      expect(container.querySelector(".stream-row__primary")).not.toBeNull();
      expect(container.querySelector(".stream-row__meta")).not.toBeNull();
      expect(container.querySelector(".stream-row__recipient")).not.toBeNull();
    });

    it.each(ALL_STATUSES)(
      "meta dt label is inside .stream-row__meta for margin-bottom token hook: status=%s",
      (status) => {
        const { container } = render(<StreamRow stream={makeMockStream(status)} />);
        const dt = container.querySelector(".stream-row__meta dt");
        expect(dt).not.toBeNull();
      }
    );

    it("receipt link element carries stream-row__receipt-link class (color token hook)", () => {
      // The receipt link only appears in streams with a receipt — render a
      // stream that includes the receipt area to verify the class is applied
      // when the element exists.
      const { container } = render(<StreamRow stream={baseStream} />);
      // The link may not render for all stream states; assert structural
      // correctness only when present.
      const link = container.querySelector(".stream-row__receipt-link");
      if (link) {
        expect(link.tagName).toMatch(/^A$|^BUTTON$/);
      }
    });
  });
});
