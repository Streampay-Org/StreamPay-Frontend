"use client";

import { useId } from "react";

/**
 * EmptyIllustration
 *
 * Decorative SVG visual for StreamRow empty states. The composition echoes
 * the color-blind safe v7 pattern vocabulary so the empty graphic feels
 * continuous with the real StreamRow cards it replaces:
 *
 *   - Top ghost row    → diagonal stripes  (active status texture)
 *   - Middle ghost row → spaced dots       (draft status texture)
 *   - Bottom ghost row → horizontal bars   (paused status texture)
 *
 * A floating "+" badge sits on top using the accent token to invite the
 * primary action.
 *
 * ## Theming
 * Every stroke / fill uses `currentColor` or a design-token var so the
 * illustration adapts cleanly to dark / light / high-contrast themes and
 * to the host element's CSS `color` (callers can tint via inline style
 * or a BEM modifier — defaults to --muted).
 *
 * ## Accessibility
 * Purely decorative — the meaningful empty-state message is in the
 * EmptyState heading + description. When `decorative` is true (default)
 * we mark the whole thing `aria-hidden`. If you need to surface the
 * visual to AT, pass `decorative={false}` and a `label`.
 *
 * ## Responsivity
 * Uses `viewBox` with a fluid default size of `100%` so the illustration
 * scales to its container; provide an explicit `size` to pin it.
 */

export interface EmptyIllustrationProps {
  /** Optional width / height in CSS units. Default: fills container, max 220px. */
  size?: number | string;
  /** Tint the graphic — defaults to --muted; rows use this via currentColor. */
  color?: string;
  /** When true, marks the graphic aria-hidden. Default: true. */
  decorative?: boolean;
  /** Accessible label (only used when decorative=false). */
  label?: string;
  /** Additional class forwarded to the wrapper. */
  className?: string;
}

export function EmptyIllustration({
  size,
  color,
  decorative = true,
  label = "Empty streams list illustration",
  className = "",
}: EmptyIllustrationProps) {
  const idPrefix = useId();
  const strokeId = `${idPrefix}-stripes`;
  const dotsId = `${idPrefix}-dots`;
  const barsId = `${idPrefix}-bars`;
  const accentGlowId = `${idPrefix}-accent-glow`;

  const wrapperStyle: React.CSSProperties = {
    display: "block",
    maxWidth: "100%",
    width: size ?? "100%",
    maxHeight: size ? undefined : "220px",
    aspectRatio: "4 / 3",
    color: color ?? "var(--muted)",
  };

  const commonProps = decorative
    ? { "aria-hidden": true as const, focusable: false as const }
    : { role: "img" as const, "aria-label": label };

  // Geometry constants — all positions relative to viewBox 0 0 400 300
  const rowWidth = 320;
  const rowHeight = 64;
  const rowX = 40;
  const rowGap = 16;
  const rowY1 = 36;
  const rowY2 = rowY1 + rowHeight + rowGap;
  const rowY3 = rowY2 + rowHeight + rowGap;

  return (
    <svg
      className={className}
      style={wrapperStyle}
      viewBox="0 0 400 300"
      preserveAspectRatio="xMidYMid meet"
      {...commonProps}
    >
      <defs>
        {/* ── v7 pattern tiles, tinted by currentColor ──────────────── */}
        <pattern id={strokeId} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="12" stroke="currentColor" strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="square" />
        </pattern>

        <pattern id={dotsId} width="12" height="12" patternUnits="userSpaceOnUse">
          <circle cx="6" cy="6" r="1.75" fill="currentColor" fillOpacity="0.6" />
        </pattern>

        <pattern id={barsId} width="12" height="12" patternUnits="userSpaceOnUse">
          <rect x="0" y="3.2" width="12" height="1.8" fill="currentColor" fillOpacity="0.6" />
          <rect x="0" y="8" width="12" height="1.8" fill="currentColor" fillOpacity="0.6" />
        </pattern>

        {/* Soft accent glow under the "+" badge */}
        <radialGradient id={accentGlowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* ── Three ghost StreamRow silhouettes ──────────────────────── */}

      {/* Row 1 — diagonal stripes (echoes "active" status pattern) */}
      <g opacity="0.92">
        <rect
          x={rowX}
          y={rowY1}
          width={rowWidth}
          height={rowHeight}
          rx="18"
          ry="18"
          fill="var(--panel-elevated)"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="1.5"
        />
        <rect
          x={rowX + 10}
          y={rowY1 + 10}
          width={rowWidth - 20}
          height={rowHeight - 20}
          rx="10"
          ry="10"
          fill={`url(#${strokeId})`}
          opacity="0.9"
        />
      </g>

      {/* Row 2 — dots (echoes "draft" status pattern) */}
      <g opacity="0.92" transform="translate(0 0)">
        <rect
          x={rowX}
          y={rowY2}
          width={rowWidth}
          height={rowHeight}
          rx="18"
          ry="18"
          fill="var(--panel)"
          stroke="currentColor"
          strokeOpacity="0.2"
          strokeWidth="1.5"
        />
        <rect
          x={rowX + 10}
          y={rowY2 + 10}
          width={rowWidth - 20}
          height={rowHeight - 20}
          rx="10"
          ry="10"
          fill={`url(#${dotsId})`}
          opacity="0.9"
        />
      </g>

      {/* Row 3 — horizontal bars (echoes "paused" status pattern) */}
      <g opacity="0.92">
        <rect
          x={rowX}
          y={rowY3}
          width={rowWidth}
          height={rowHeight}
          rx="18"
          ry="18"
          fill="var(--panel)"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1.5"
        />
        <rect
          x={rowX + 10}
          y={rowY3 + 10}
          width={rowWidth - 20}
          height={rowHeight - 20}
          rx="10"
          ry="10"
          fill={`url(#${barsId})`}
          opacity="0.9"
        />
      </g>

      {/* ── Accent "+" badge (invitation to create) ────────────────── */}

      {/* Glow halo */}
      <circle cx={rowX + rowWidth} cy={rowY1 + 4} r="42" fill={`url(#${accentGlowId})`} />

      {/* Badge body */}
      <g transform={`translate(${rowX + rowWidth - 6} ${rowY1 - 6})`}>
        <circle
          cx="0"
          cy="0"
          r="22"
          fill="var(--panel-elevated)"
          stroke="var(--accent)"
          strokeWidth="2.5"
        />
        {/* Plus glyph — rendered with strokes so it stays crisp at any size */}
        <line x1="-10" y1="0" x2="10" y2="0" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
        <line x1="0" y1="-10" x2="0" y2="10" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export default EmptyIllustration;
