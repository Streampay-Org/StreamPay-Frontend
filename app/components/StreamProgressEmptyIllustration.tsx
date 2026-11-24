"use client";

import { useId } from "react";

export interface StreamProgressEmptyIllustrationProps {
  /** Optional width / height in CSS units. Default: fills container, max 220px. */
  size?: number | string;
  /** Tint the graphic — defaults to --muted. */
  color?: string;
  /** When true, marks the graphic aria-hidden. Default: true. */
  decorative?: boolean;
  /** Accessible label (only used when decorative=false). */
  label?: string;
  /** Additional class forwarded to the wrapper. */
  className?: string;
}

export function StreamProgressEmptyIllustration({
  size,
  color,
  decorative = true,
  label = "Empty stream progress illustration",
  className = "",
}: StreamProgressEmptyIllustrationProps) {
  const idPrefix = useId();
  const glowId = `${idPrefix}-glow`;
  const patternId = `${idPrefix}-stripes`;

  const wrapperStyle: React.CSSProperties = {
    display: "block",
    maxWidth: "100%",
    width: size ?? "100%",
    maxHeight: size ? undefined : "160px",
    aspectRatio: "16 / 9",
    color: color ?? "var(--muted)",
  };

  const commonProps = decorative
    ? { "aria-hidden": true as const, focusable: false as const }
    : { role: "img" as const, "aria-label": label };

  return (
    <svg
      className={className}
      style={wrapperStyle}
      viewBox="0 0 400 180"
      preserveAspectRatio="xMidYMid meet"
      {...commonProps}
    >
      <defs>
        {/* Soft accent glow under the central clock badge */}
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>

        {/* Diagonal stripe pattern for a ghost fill chunk at the start */}
        <pattern
          id={patternId}
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="12"
            stroke="currentColor"
            strokeOpacity="0.2"
            strokeWidth="2"
          />
        </pattern>
      </defs>

      {/* ── Outer Group ─────────────────────────────────────────────────── */}
      <g opacity="0.9">
        {/* Main progress bar track (dashed/ghost outline) */}
        <rect
          x="30"
          y="70"
          width="340"
          height="40"
          rx="20"
          ry="20"
          fill="var(--panel)"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1.5"
          strokeDasharray="6 4"
        />

        {/* Muted ghost fill pattern at the beginning (0-15% area) */}
        <rect
          x="34"
          y="74"
          width="50"
          height="32"
          rx="16"
          ry="16"
          fill={`url(#${patternId})`}
          opacity="0.8"
        />
      </g>

      {/* ── Central Badge (Time / Clock Theme) ────────────────────────── */}

      {/* Glow halo */}
      <circle cx="200" cy="90" r="48" fill={`url(#${glowId})`} />

      {/* Badge container */}
      <g transform="translate(200 90)">
        {/* Outer ring */}
        <circle
          cx="0"
          cy="0"
          r="26"
          fill="var(--panel-elevated)"
          stroke="var(--accent)"
          strokeWidth="2.5"
        />

        {/* Clock outline */}
        <circle
          cx="0"
          cy="0"
          r="12"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
        />

        {/* Clock hands */}
        <line
          x1="0"
          y1="0"
          x2="0"
          y2="-7"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <line
          x1="0"
          y1="0"
          x2="5"
          y2="0"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

export default StreamProgressEmptyIllustration;
