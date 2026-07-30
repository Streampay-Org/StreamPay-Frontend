/**
 * @jest-environment jsdom
 *
 * Focused tests for the WalletBadge loading skeleton (#1073).
 *
 * Covers:
 *  - loading=true renders the skeleton and suppresses real badge markup
 *  - WalletBadgeSkeleton renders with correct ARIA attributes
 *  - showExtendedSkeleton controls network+balance slots
 *  - loading=false (default) still renders the real badge
 *  - skeleton is not interactive (no role="button", no tabIndex)
 *  - data-testid="wallet-badge-skeleton" is present for E2E targeting
 *  - WalletBadgeSkeleton is exported from the shim
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { WalletBadge } from "./WalletBadge";
import { WalletBadgeSkeleton } from "./components/Skeleton";
import { WalletBadgeSkeleton as WalletBadgeSkeletonFromShim } from "./components/WalletBadge";

// ── matchMedia stub (not relevant for these tests but guards against errors) ──
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WalletBadge  loading  prop
// ═══════════════════════════════════════════════════════════════════════════════

describe("WalletBadge — loading prop", () => {
  it("renders the skeleton and hides the real badge when loading=true", () => {
    render(<WalletBadge loading />);

    // Skeleton must be present
    expect(screen.getByTestId("wallet-badge-skeleton")).toBeInTheDocument();
    // Real badge must NOT be rendered
    expect(screen.queryByTestId("wallet-badge")).not.toBeInTheDocument();
  });

  it("renders the real badge by default (loading omitted)", () => {
    render(<WalletBadge state="disconnected" />);

    expect(screen.getByTestId("wallet-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-badge-skeleton")).not.toBeInTheDocument();
  });

  it("renders the real badge when loading=false (explicit)", () => {
    render(<WalletBadge loading={false} state="connected" address="GABCD1234" />);

    expect(screen.getByTestId("wallet-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-badge-skeleton")).not.toBeInTheDocument();
  });

  it("forwards className to the skeleton wrapper", () => {
    render(<WalletBadge loading className="my-custom-class" />);

    const skeleton = screen.getByTestId("wallet-badge-skeleton");
    expect(skeleton).toHaveClass("my-custom-class");
  });

  it("skeleton is not interactive: has no role=button and no tabIndex", () => {
    render(<WalletBadge loading />);

    const skeleton = screen.getByTestId("wallet-badge-skeleton");
    expect(skeleton).not.toHaveAttribute("role", "button");
    expect(skeleton).not.toHaveAttribute("tabIndex");
  });

  it("skeleton carries aria-busy=true and aria-label announcing loading state", () => {
    render(<WalletBadge loading />);

    const skeleton = screen.getByTestId("wallet-badge-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton).toHaveAttribute("aria-label", "Loading wallet…");
  });

  it("skeleton has BEM modifier class wallet-badge--loading", () => {
    render(<WalletBadge loading />);

    const skeleton = screen.getByTestId("wallet-badge-skeleton");
    expect(skeleton).toHaveClass("wallet-badge--loading");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WalletBadge  showExtendedSkeleton  prop
// ═══════════════════════════════════════════════════════════════════════════════

describe("WalletBadge — showExtendedSkeleton prop", () => {
  it("hides network + balance slots by default (compact skeleton)", () => {
    render(<WalletBadge loading />);

    const { container } = render(<WalletBadge loading />);
    expect(
      container.querySelector(".wallet-badge-skeleton__network")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(".wallet-badge-skeleton__balance")
    ).not.toBeInTheDocument();
  });

  it("shows network + balance slots when showExtendedSkeleton=true", () => {
    const { container } = render(<WalletBadge loading showExtendedSkeleton />);

    expect(
      container.querySelector(".wallet-badge-skeleton__network")
    ).toBeInTheDocument();
    expect(
      container.querySelector(".wallet-badge-skeleton__balance")
    ).toBeInTheDocument();
  });

  it("compact skeleton always has dot + label slots", () => {
    const { container } = render(<WalletBadge loading />);

    expect(
      container.querySelector(".wallet-badge-skeleton__dot")
    ).toBeInTheDocument();
    expect(
      container.querySelector(".wallet-badge-skeleton__label")
    ).toBeInTheDocument();
  });

  it("extended skeleton has all four slots", () => {
    const { container } = render(<WalletBadge loading showExtendedSkeleton />);

    expect(container.querySelector(".wallet-badge-skeleton__dot")).toBeInTheDocument();
    expect(container.querySelector(".wallet-badge-skeleton__label")).toBeInTheDocument();
    expect(container.querySelector(".wallet-badge-skeleton__network")).toBeInTheDocument();
    expect(container.querySelector(".wallet-badge-skeleton__balance")).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WalletBadgeSkeleton  standalone component
// ═══════════════════════════════════════════════════════════════════════════════

describe("WalletBadgeSkeleton — standalone", () => {
  it("renders a testid element by default", () => {
    render(<WalletBadgeSkeleton />);
    expect(screen.getByTestId("wallet-badge-skeleton")).toBeInTheDocument();
  });

  it("renders with aria-hidden inner slots (dot, label)", () => {
    const { container } = render(<WalletBadgeSkeleton />);

    const dot = container.querySelector(".wallet-badge-skeleton__dot");
    const label = container.querySelector(".wallet-badge-skeleton__label");

    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute("aria-hidden", "true");

    expect(label).toBeInTheDocument();
    expect(label).toHaveAttribute("aria-hidden", "true");
  });

  it("all inner skeleton slots carry both the global .skeleton class and a variant class", () => {
    const { container } = render(<WalletBadgeSkeleton showExtended />);

    const slots = [
      ".wallet-badge-skeleton__dot",
      ".wallet-badge-skeleton__label",
      ".wallet-badge-skeleton__network",
      ".wallet-badge-skeleton__balance",
    ];

    slots.forEach((selector) => {
      const el = container.querySelector(selector);
      expect(el).toBeInTheDocument();
      expect(el).toHaveClass("skeleton");
    });
  });

  it("does NOT render network/balance when showExtended=false (default)", () => {
    const { container } = render(<WalletBadgeSkeleton />);

    expect(
      container.querySelector(".wallet-badge-skeleton__network")
    ).not.toBeInTheDocument();
    expect(
      container.querySelector(".wallet-badge-skeleton__balance")
    ).not.toBeInTheDocument();
  });

  it("renders network/balance when showExtended=true", () => {
    const { container } = render(<WalletBadgeSkeleton showExtended />);

    expect(
      container.querySelector(".wallet-badge-skeleton__network")
    ).toBeInTheDocument();
    expect(
      container.querySelector(".wallet-badge-skeleton__balance")
    ).toBeInTheDocument();
  });

  it("accepts an additional className", () => {
    render(<WalletBadgeSkeleton className="extra-class" />);
    expect(screen.getByTestId("wallet-badge-skeleton")).toHaveClass("extra-class");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Re-export shim
// ═══════════════════════════════════════════════════════════════════════════════

describe("WalletBadgeSkeleton — re-exported from shim", () => {
  it("is exported from app/components/WalletBadge.tsx", () => {
    expect(typeof WalletBadgeSkeletonFromShim).toBe("function");
  });

  it("shim export and direct export are the same component", () => {
    expect(WalletBadgeSkeletonFromShim).toBe(WalletBadgeSkeleton);
  });
});
