/**
 * @jest-environment jsdom
 */

import fs from "fs";
import path from "path";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { WalletBadge } from "./WalletBadge";

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

describe("WalletBadge", () => {
  it("renders disconnected state by default with connect label and SR announcement", () => {
    render(<WalletBadge providerName="Freighter" />);
    const badge = screen.getByTestId("wallet-badge");
    expect(badge).toBeInTheDocument();
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
    const liveRegion = screen.getByTestId("live-region");
    expect(liveRegion).toHaveTextContent("Freighter disconnected.");
  });

  it("announces connecting state via live region", () => {
    render(<WalletBadge state="connecting" providerName="Freighter" />);
    expect(screen.getByText("Connecting Freighter...")).toBeInTheDocument();
    const liveRegion = screen.getByTestId("live-region");
    expect(liveRegion).toHaveTextContent("Connecting to Freighter...");
  });

  it("announces connected state with formatted address, network, and balance", () => {
    render(
      <WalletBadge
        state="connected"
        address="GABCD1234567890XYZ"
        providerName="Freighter"
        network="Testnet"
        balance="150.00 XLM"
      />
    );
    expect(screen.getByText("GABC...0XYZ")).toBeInTheDocument();
    expect(screen.getByText("Testnet")).toBeInTheDocument();
    expect(screen.getByText("150.00 XLM")).toBeInTheDocument();

    const liveRegion = screen.getByTestId("live-region");
    expect(liveRegion).toHaveTextContent(
      "Freighter connected. Address: GABC...0XYZ. Network: Testnet. Balance: 150.00 XLM."
    );
  });

  it("announces error state with errorMessage", () => {
    render(
      <WalletBadge
        state="error"
        errorMessage="User rejected connection"
        providerName="Albedo"
      />
    );
    expect(screen.getByText("User rejected connection")).toBeInTheDocument();
    const liveRegion = screen.getByTestId("live-region");
    expect(liveRegion).toHaveTextContent("Wallet connection error: User rejected connection");
  });

  it("invokes onConnect when clicked in disconnected state", () => {
    const handleConnect = jest.fn();
    render(<WalletBadge state="disconnected" onConnect={handleConnect} />);
    fireEvent.click(screen.getByTestId("wallet-badge"));
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it("invokes onDisconnect when disconnect button is clicked in connected state", () => {
    const handleDisconnect = jest.fn();
    render(
      <WalletBadge
        state="connected"
        address="GABCD1234567890XYZ"
        onDisconnect={handleDisconnect}
      />
    );
    const disconnectBtn = screen.getByRole("button", { name: "Disconnect wallet" });
    fireEvent.click(disconnectBtn);
    expect(handleDisconnect).toHaveBeenCalledTimes(1);
  });

  it("respects custom announcement override", () => {
    render(
      <WalletBadge
        state="connected"
        address="GABCD1234567890XYZ"
        announcement="Custom screen reader message"
      />
    );
    const liveRegion = screen.getByTestId("live-region");
    expect(liveRegion).toHaveTextContent("Custom screen reader message");
  });

  it("applies responsive CSS module classes and BEM classes correctly", () => {
    const { container } = render(
      <WalletBadge
        state="connected"
        address="GABCD1234567890XYZ"
        network="Mainnet"
        balance="500.00 XLM"
        className="custom-badge-class"
      />
    );
    const badge = screen.getByTestId("wallet-badge");
    expect(badge).toHaveClass("wallet-badge");
    expect(badge).toHaveClass("wallet-badge--connected");
    expect(badge).toHaveClass("custom-badge-class");

    const networkTag = container.querySelector(".wallet-badge__network");
    expect(networkTag).toBeInTheDocument();
    expect(networkTag).toHaveTextContent("Mainnet");

    const balanceTag = container.querySelector(".wallet-badge__balance");
    expect(balanceTag).toBeInTheDocument();
    expect(balanceTag).toHaveTextContent("500.00 XLM");
  });

  it("supports keyboard navigation with Enter and Space keys when interactive", () => {
    const handleConnect = jest.fn();
    render(<WalletBadge state="disconnected" onConnect={handleConnect} />);
    const badge = screen.getByTestId("wallet-badge");
    expect(badge).toHaveAttribute("role", "button");
    expect(badge).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(badge, { key: "Enter" });
    expect(handleConnect).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(badge, { key: " " });
    expect(handleConnect).toHaveBeenCalledTimes(2);
  });

  it("renders non-interactive region when no onClick or onConnect callback is provided", () => {
    render(<WalletBadge state="connecting" />);
    const badge = screen.getByTestId("wallet-badge");
    expect(badge).toHaveAttribute("role", "region");
    expect(badge).not.toHaveAttribute("tabIndex");
  });

  describe("color-blind pattern fills", () => {
    it.each([
      ["disconnected", "cb-pattern--draft"],
      ["connecting", "cb-pattern--active"],
      ["connected", "cb-pattern--ended"],
      ["error", "cb-pattern--cancelled"],
      ["disconnecting", "cb-pattern--paused"],
    ])("applies %s → %s pattern class to the status dot", (state, expectedPattern) => {
      const { container } = render(
        <WalletBadge state={state as any} />
      );
      const dot = container.querySelector(".wallet-badge__dot");
      expect(dot).toHaveClass("cb-pattern");
      expect(dot).toHaveClass(expectedPattern);
    });

    it("applies distinct pattern classes across all wallet states", () => {
      const states = [
        "disconnected",
        "connecting",
        "connected",
        "error",
        "disconnecting",
      ] as const;

      const patterns = states.map((state) => {
        const { container } = render(
          <WalletBadge state={state} />
        );
        return Array.from(
          container.querySelector(".wallet-badge__dot")?.classList ?? []
        );
      });

      // Every state must carry at least cb-pattern + one specific pattern class
      patterns.forEach((clsList, i) => {
        expect(clsList).toContain("cb-pattern");
        expect(
          clsList.filter((c) => c.startsWith("cb-pattern--"))
        ).toHaveLength(1);
      });

      // All five pattern classes must be distinct (no two states share the same texture)
      const patternClasses = patterns.map(
        (cls) => cls.find((c) => c.startsWith("cb-pattern--"))!
      );
      expect(new Set(patternClasses).size).toBe(states.length);
    });
  });
});
