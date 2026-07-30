/**
 * LiveRegion
 *
 * Reusable ARIA live region wrapper that announces state changes to assistive
 * technologies without requiring visual focus shifts.
 *
 * ## Why this component?
 * Screen readers only announce DOM changes that occur inside live regions.
 * Placing `aria-live` in an isolated, always-mounted `<div>` avoids common
 * pitfalls such as:
 *   - The region being added and removed from the DOM (AT may miss the first
 *     announcement).
 *   - Updates being lost because the region was not mounted when the content
 *     was set.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - `role="status"` + `aria-live="polite"` — for non-urgent status updates.
 *   Screen readers finish the current sentence before announcing.
 * - `role="alert"` + `aria-live="assertive"` — for error / urgent messages.
 *   Screen readers interrupt the current sentence immediately.
 * - `aria-atomic="true"` (default) — the full message is read, not just the
 *   changed fragment, so announcements are never partial.
 * - Visually hidden via `.sr-only` so the region never affects layout.
 *
 * ## Usage
 * ```tsx
 * // Non-urgent status (loading, success)
 * <LiveRegion message="Stream created successfully." />
 *
 * // Urgent error (use assertive sparingly — it interrupts)
 * <LiveRegion message="Submission failed: network error." politeness="assertive" />
 *
 * // Silence the region
 * <LiveRegion message="" />
 *
 * // Non-atomic — only changed words are announced (rarely needed)
 * <LiveRegion message="3 of 5 steps complete" atomic={false} />
 * ```
 *
 * ## CreateStreamForm integration (ariallive-v7)
 * `CreateStreamForm` mounts a single `<LiveRegion>` at render time and
 * updates its `message` prop on each state transition:
 *
 * | State          | Politeness  | Announcement text                         |
 * |----------------|-------------|-------------------------------------------|
 * | Loading        | polite      | "Loading stream creation form…"           |
 * | Submitting     | polite      | "Creating stream, please wait…"           |
 * | Success        | polite      | "Stream created successfully."            |
 * | Error          | polite      | "Stream creation failed: <error message>" |
 * | Cancelled      | polite      | "Stream creation cancelled."              |
 */

"use client";

import React from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AriaLive = "polite" | "assertive" | "off";

export interface LiveRegionProps {
  /** Text announced to screen readers. Pass empty string to silence. */
  message: string;
  /**
   * ARIA live-region politeness level.
   *
   * - `"polite"` (default) — waits for the current sentence to finish.
   *   Use for status updates, success messages, and loading indicators.
   * - `"assertive"` — interrupts immediately. Reserve for critical errors.
   * - `"off"` — disables announcements. Useful when the message is already
   *   conveyed through focused element state.
   */
  politeness?: AriaLive;
  /**
   * When `true` (default) the entire region content is announced on each
   * update, not just the diff. Recommended for short status messages.
   */
  atomic?: boolean;
  /** Optional `data-testid` for test selectors. */
  "data-testid"?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Mounts a persistent, visually-hidden live region.
 *
 * Keep this component **always mounted** for the lifetime of the parent so
 * screen readers register the region before the first announcement fires.
 * Swap `message` props to trigger announcements rather than mounting /
 * unmounting this component.
 */
export function LiveRegion({
  message,
  politeness = "polite",
  atomic = true,
  "data-testid": testId,
}: LiveRegionProps) {
  // Use role="alert" for assertive regions — it is the semantic pairing
  // required by WCAG technique ARIA19 and ensures maximum AT compatibility.
  const role = politeness === "assertive" ? "alert" : "status";

  return (
    <div
      className="sr-only"
      role={role}
      aria-live={politeness}
      aria-atomic={atomic}
      data-testid={testId}
    >
      {message}
    </div>
  );
}
