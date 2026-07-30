/**
 * LiveRegion
 *
 * Reusable wrapper for ARIA live regions.  Renders a visually-hidden `<div>`
 * that announces its `message` content to assistive technologies whenever the
 * value changes.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - `role="status"` + `aria-live` ensures screen readers pick up updates
 *   without requiring focus.
 * - The region is visually hidden via the existing `.sr-only` utility so it
 *   never affects layout.
 * - `aria-atomic="true"` (default) announces the full message on each update,
 *   not just the diff.
 *
 * ## Usage
 * ```tsx
 * <LiveRegion message="Stream completed" />
 * <LiveRegion message="Error occurred" politeness="assertive" />
 * ```
 */

"use client";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AriaLive = "polite" | "assertive" | "off";

export interface LiveRegionProps {
  /** Text announced to screen readers.  Pass empty string to silence. */
  message: string;
  /** ARIA live-region politeness level.  Default `"polite"`. */
  politeness?: AriaLive;
  /** When true the entire region content is announced, not just the diff.  Default `true`. */
  atomic?: boolean;
  /** Optional data-testid for test selectors. */
  "data-testid"?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LiveRegion({
  message,
  politeness = "polite",
  atomic = true,
  "data-testid": testId,
}: LiveRegionProps) {
  return (
    <div
      className="sr-only"
      role="status"
      aria-live={politeness}
      aria-atomic={atomic}
      data-testid={testId}
    >
      {message}
    </div>
  );
}
