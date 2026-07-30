"use client";

import React, { useEffect, useMemo, useState } from "react";
import { LiveRegion } from "../src/components/LiveRegion";
import { KbdHint } from "../src/components/KbdHint";
import { EmptyState } from "../src/components/EmptyState";
import styles from "./WalletBadge.module.css";

export type WalletState = "disconnected" | "connecting" | "connected" | "error" | "disconnecting";

export interface WalletBadgeProps {
  /** Connection state of the wallet */
  state?: WalletState;
  /** Stellar wallet public key / address */
  address?: string | null;
  /** Name of the connected wallet provider (e.g. Freighter, Albedo) */
  providerName?: string;
  /** Connected network name (e.g. Mainnet, Testnet) */
  network?: string;
  /** Formatted balance string (e.g. "100.00 XLM") */
  balance?: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
  /** Error details if state === "error" */
  errorMessage?: string;
  /** Callback triggered when user clicks connect */
  onConnect?: () => void;
  /** Callback triggered when user clicks disconnect */
  onDisconnect?: () => void;
  /** Callback triggered when user clicks the badge container */
  onClick?: () => void;
  /** Screen reader announcement politeness level */
  politeness?: "polite" | "assertive";
  /** Manual announcement message override */
  announcement?: string;
  /** Additional CSS class names */
  className?: string;
  /** Whether to show a detailed empty state when disconnected */
  showEmptyState?: boolean;
}

/**
 * Tracks the user's `prefers-reduced-motion` setting.
 *
 * Returns `true` when reduced motion is requested. SSR-safe: defaults to
 * `false` before hydration and updates live if the preference changes.
 * Used to swap animated connecting/status transitions for a static fallback.
 */
function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }

    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return prefersReduced;
}

/**
 * WalletBadge displays current wallet status and announces state changes via an ARIA live region.
 * Refactored for Issue #1072 with responsive breakpoint layout rules, design tokens, and WCAG accessibility.
 * Issue #1078: static fallback when `prefers-reduced-motion: reduce` is set.
 */
export function WalletBadge({
  state = "disconnected",
  address = null,
  providerName,
  network,
  balance,
  shortcut,
  errorMessage,
  onConnect,
  onDisconnect,
  onClick,
  politeness = "polite",
  announcement,
  className = "",
  showEmptyState = false,
}: WalletBadgeProps) {
  const [srMessage, setSrMessage] = useState<string>("");
  const prefersReducedMotion = usePrefersReducedMotion();

  const formattedAddress = useMemo(() => {
    if (!address) return "";
    if (address.length <= 10) return address;
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  }, [address]);

  // Generate SR-announce text on state/prop changes
  useEffect(() => {
    if (announcement !== undefined) {
      setSrMessage(announcement);
      return;
    }

    const provider = providerName ? providerName : "Wallet";

    switch (state) {
      case "connecting":
        setSrMessage(`Connecting to ${provider}...`);
        break;
      case "connected": {
        const parts = [`${provider} connected.`];
        if (formattedAddress) parts.push(`Address: ${formattedAddress}.`);
        if (network) parts.push(`Network: ${network}.`);
        if (balance) parts.push(`Balance: ${balance}.`);
        setSrMessage(parts.join(" "));
        break;
      }
      case "disconnecting":
        setSrMessage(`Disconnecting from ${provider}...`);
        break;
      case "disconnected":
        setSrMessage(`${provider} disconnected.`);
        break;
      case "error":
        setSrMessage(`Wallet connection error: ${errorMessage || "Failed to connect"}`);
        break;
      default:
        setSrMessage("");
    }
  }, [state, address, formattedAddress, providerName, network, balance, errorMessage, announcement]);

  const handleAction = (e: React.MouseEvent) => {
    if (onClick) onClick();
    if (state === "disconnected" && onConnect) {
      onConnect();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (onClick) onClick();
      if (state === "disconnected" && onConnect) {
        onConnect();
      }
    }
  };

  const getDotStyleClass = () => {
    switch (state) {
      case "connected":
        return styles.dotConnected;
      case "connecting":
        return styles.dotConnecting;
      case "disconnecting":
        return styles.dotDisconnecting;
      case "error":
        return styles.dotError;
      case "disconnected":
      default:
        return styles.dotDisconnected;
    }
  };

  const getPatternClass = (): string => {
    switch (state) {
      case "connected":
        return "cb-pattern--ended";
      case "connecting":
        return "cb-pattern--active";
      case "disconnecting":
        return "cb-pattern--paused";
      case "error":
        return "cb-pattern--cancelled";
      case "disconnected":
      default:
        return "cb-pattern--draft";
    }
  };

  const isInteractive = Boolean(onClick || (state === "disconnected" && onConnect));

  if (showEmptyState && state === "disconnected") {
    return (
      <EmptyState
        title="Wallet Disconnected"
        description="Connect your Stellar wallet to participate in the GrantFox campaign."
        illustration={
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
            <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
            <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
          </svg>
        }
        ctaText="Connect Wallet"
        onCtaClick={onConnect}
        className={className}
        testId="wallet-badge-empty-state"
      />
    );
  }

  const motionClass = prefersReducedMotion ? styles.badgeStatic : styles.badgeAnimated;

  return (
    <div
      className={`wallet-badge wallet-badge--${state} ${styles.badge} ${motionClass} ${isInteractive ? styles.badgeInteractive : ""} ${className}`.trim()}
      onClick={handleAction}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      role={isInteractive ? "button" : "region"}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={`Wallet status: ${state}`}
      data-testid="wallet-badge"
      data-reduced-motion={prefersReducedMotion ? "true" : "false"}
      style={{
        transition: prefersReducedMotion
          ? "none"
          : "background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease",
      }}
    >
      {/* Status Dot with color-blind-safe pattern overlay (shape + texture beyond colour) */}
      <span
        className={`wallet-badge__dot ${styles.dot} ${getDotStyleClass()} cb-pattern ${getPatternClass()}`}
        aria-hidden="true"
        data-reduced-motion={prefersReducedMotion ? "true" : "false"}
        style={{
          transition: prefersReducedMotion ? "none" : "background-color 0.2s ease",
          animation: prefersReducedMotion ? "none" : undefined,
        }}
      />

      {/* Main Content */}
      <span className={`wallet-badge__label ${styles.label}`}>
        {state === "connecting" && (providerName ? `Connecting ${providerName}...` : "Connecting...")}
        {state === "disconnecting" && "Disconnecting..."}
        {state === "error" && (errorMessage || "Connection Error")}
        {state === "disconnected" && "Connect Wallet"}
        {state === "connected" && (
          <>
            {providerName && (
              <span className={`wallet-badge__provider-prefix ${styles.providerPrefix}`}>
                {providerName}:
              </span>
            )}
            <span>{formattedAddress || "Connected"}</span>
          </>
        )}
      </span>

      {/* Optional Network tag */}
      {state === "connected" && network && (
        <span
          className={`wallet-badge__network ${styles.network}`}
        >
          {network}
        </span>
      )}

      {/* Optional Balance tag */}
      {state === "connected" && balance && (
        <span className={`wallet-badge__balance ${styles.balance}`}>
          {balance}
        </span>
      )}

      {/* Keyboard Shortcut Hint */}
      {shortcut && isInteractive && (
        <KbdHint shortcut={shortcut} className={`wallet-badge__kbd ${styles.kbdHint}`} />
      )}

      {/* Disconnect Action Button */}
      {state === "connected" && onDisconnect && (
        <button
          type="button"
          className={`wallet-badge__disconnect ${styles.disconnect}`}
          onClick={(e) => {
            e.stopPropagation();
            onDisconnect();
          }}
          aria-label="Disconnect wallet"
        >
          ✕
        </button>
      )}

      {/* ARIA Live Region Announcement */}
      <LiveRegion message={srMessage} politeness={politeness} data-testid="live-region" />
    </div>
  );
}

export default WalletBadge;
