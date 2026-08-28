/**
 * LiveRegion
 *
 * Reusable wrapper for ARIA live regions. Renders a visually-hidden `<div>`
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
 * - Deduplicates consecutive identical announcements by default to prevent
 *   repetitive noise for screen reader users.
 */

"use client";

import React, { useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export type AriaLive = "polite" | "assertive" | "off";

export interface LiveRegionProps {
  /** Text announced to screen readers. Pass empty string to silence. */
  message: string;
  /** ARIA live-region politeness level. Default `"polite"`. */
  politeness?: AriaLive;
  /** When true the entire region content is announced, not just the diff. Default `true`. */
  atomic?: boolean;
  /**
   * When true (default), prevents consecutive identical messages from triggering
   * redundant announcements.
   * @default true
   */
  deduplicate?: boolean;
  /**
   * When true, bypasses deduplication to re-announce the same message.
   * @default false
   */
  allowDuplicates?: boolean;
  /** Optional data-testid for test selectors. */
  "data-testid"?: string;
}

// ── Component ──────────────────────────────────────────────────────────────

export function LiveRegion({
  message,
  politeness = "polite",
  atomic = true,
  deduplicate = true,
  allowDuplicates = false,
  "data-testid": testId,
}: LiveRegionProps) {
  const [announcedMessage, setAnnouncedMessage] = useState(message);
  const lastAnnouncedRef = useRef(message);

  useEffect(() => {
    const shouldDeduplicate = deduplicate && !allowDuplicates;
    const trimmedCurrent = message.trim();
    const trimmedLast = lastAnnouncedRef.current.trim();

    if (
      shouldDeduplicate &&
      trimmedCurrent === trimmedLast &&
      message === announcedMessage
    ) {
      return;
    }

    lastAnnouncedRef.current = message;
    setAnnouncedMessage(message);
  }, [message, deduplicate, allowDuplicates, announcedMessage]);

  return (
    <div
      className="sr-only"
      role="status"
      aria-live={politeness}
      aria-atomic={atomic}
      data-testid={testId}
    >
      {announcedMessage}
    </div>
  );
}
