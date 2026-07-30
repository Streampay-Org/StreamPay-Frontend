"use client";

/**
 * Skeleton — loading placeholder primitives for the StreamPay UI.
 *
 * ## Design tokens
 * All animation colours are driven by `--skeleton-base` and `--skeleton-shine`
 * CSS custom properties (defined in `app/globals.css`) so dark-mode and
 * theme overrides work automatically.
 *
 * ## Accessibility
 * Every element rendered by this module carries `aria-hidden="true"`.
 * Where a skeleton replaces meaningful content, add a sibling
 * `<span className="sr-only">Loading…</span>` or use a live-region.
 */

import React from "react";

export type SkeletonVariant =
  | "title"
  | "text"
  | "badge"
  | "label"
  | "value"
  | "button";

export interface SkeletonProps {
  /** Optional width to override default variant width */
  width?: string | number;
  /** Optional height to override default variant height */
  height?: string | number;
  /** Set to true for a circular skeleton */
  circle?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Predetermined variant that matches global CSS tokens for consistent parity */
  variant?: SkeletonVariant;
}

/**
 * Low-level shimmer block.
 * Implements WCAG 2.1 AA: hidden from the AT tree via `aria-hidden`.
 */
export const Skeleton = ({
  width,
  height,
  circle = false,
  className = "",
  variant,
}: SkeletonProps) => {
  // Compute classes with variant priority. Base '.skeleton' class handles
  // dark-mode styles via CSS variables.
  const variantClass = variant ? `skeleton--${variant}` : "";
  const finalClassName = `skeleton ${variantClass} ${className}`.trim();

  // When a variant is provided, the CSS class supplies the default size;
  // only apply inline dimensions when the caller explicitly provides them.
  const finalWidth = width ?? (variant ? undefined : "100%");
  const finalHeight = height ?? (variant ? undefined : "1rem");

  return (
    <div
      className={finalClassName}
      aria-hidden="true"
      style={{
        width: typeof finalWidth === "number" ? `${finalWidth}px` : finalWidth,
        height:
          typeof finalHeight === "number" ? `${finalHeight}px` : finalHeight,
        borderRadius: circle ? "50%" : undefined,
      }}
    />
  );
};

// ─── WalletBadge skeleton ────────────────────────────────────────────────────

export interface WalletBadgeSkeletonProps {
  /**
   * When true, also renders placeholder slots for the network tag and
   * balance label (mimics a fully-connected WalletBadge).
   */
  showExtended?: boolean;
  /** Additional CSS classes forwarded to the root element. */
  className?: string;
}

/**
 * WalletBadgeSkeleton — themed shimmer placeholder that exactly mirrors the
 * real WalletBadge layout (dot + label, optionally + network + balance).
 *
 * Renders while the wallet connection state is being hydrated on first paint.
 *
 * ### Usage
 * ```tsx
 * <WalletBadge loading />
 * // internally renders <WalletBadgeSkeleton />
 * ```
 *
 * ### Accessibility
 * The whole skeleton is wrapped in a `<div aria-label="Loading wallet…"
 * aria-busy="true">` so assistive technologies announce that content is
 * loading rather than being silently absent.
 */
export function WalletBadgeSkeleton({
  showExtended = false,
  className = "",
}: WalletBadgeSkeletonProps) {
  return (
    <div
      className={`wallet-badge wallet-badge--loading wallet-badge-skeleton ${className}`.trim()}
      data-testid="wallet-badge-skeleton"
      aria-label="Loading wallet…"
      aria-busy="true"
    >
      {/* Status-dot placeholder */}
      <span
        className="wallet-badge-skeleton__dot skeleton skeleton--badge"
        aria-hidden="true"
        style={{ width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0 }}
      />

      {/* Primary label placeholder */}
      <span
        className="wallet-badge-skeleton__label skeleton skeleton--text"
        aria-hidden="true"
        style={{ width: "96px", height: "0.875rem" }}
      />

      {/* Optional extended slots (network + balance) */}
      {showExtended && (
        <>
          <span
            className="wallet-badge-skeleton__network skeleton skeleton--badge"
            aria-hidden="true"
            style={{ width: "52px", height: "1.25rem" }}
          />
          <span
            className="wallet-badge-skeleton__balance skeleton skeleton--value"
            aria-hidden="true"
            style={{ width: "72px", height: "0.875rem" }}
          />
        </>
      )}
    </div>
  );
}
