"use client";

import React from "react";

/**
 * Themed empty-state illustration for StreamTypeChip (Issue #1085).
 * Decorative SVG echoing a chip / tag shape — aria-hidden by default.
 */
export function StreamTypeChipEmptyIllustration({
  className = "",
}: {
  className?: string;
}) {
  return (
    <svg
      className={className}
      width="96"
      height="72"
      viewBox="0 0 96 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* Ghost chip outline */}
      <rect
        x="12"
        y="22"
        width="72"
        height="28"
        rx="14"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="2"
        strokeDasharray="5 4"
        fill="var(--panel-elevated, #27272a)"
      />
      {/* Type label placeholder */}
      <rect
        x="24"
        y="30"
        width="28"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.25"
      />
      {/* Amount placeholder */}
      <rect
        x="56"
        y="30"
        width="16"
        height="6"
        rx="3"
        fill="currentColor"
        fillOpacity="0.15"
      />
      {/* Accent dot */}
      <circle cx="48" cy="14" r="5" fill="var(--accent, #22c55e)" fillOpacity="0.55" />
      <path
        d="M48 20v6"
        stroke="var(--accent, #22c55e)"
        strokeOpacity="0.45"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default StreamTypeChipEmptyIllustration;
