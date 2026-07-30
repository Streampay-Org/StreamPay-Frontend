import type { StreamStatus } from "@/app/types/openapi";

const statusBadgeCopy: Record<StreamStatus, string> = {
  active: "Active",
  draft: "Draft",
  ended: "Ended",
  paused: "Paused",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
};

export type { StreamStatus };

/**
 * Distinct glyph per status so the state is conveyed by **shape as well as
 * colour**. This keeps the badge legible for users with colour-vision
 * deficiency and passes colour-blind simulator checks (the shapes remain
 * distinguishable under protanopia/deuteranopia/tritanopia).
 *
 * - active    → ▶ play (flowing)
 * - paused    → ‖ two bars (paused)
 * - ended     → ■ filled square (stopped)
 * - draft     → ○ hollow circle (not started)
 * - cancelled → ✕ crossed (aborted)
 * - withdrawn → ⇤ pulled back (reclaimed)
 */
const statusBadgeGlyph: Record<StreamStatus, string> = {
  active: "▶",
  paused: "‖",
  ended: "■",
  draft: "○",
  cancelled: "✕",
  withdrawn: "⇤",
};

/**
 * Pattern-class fallback mapping.  `withdrawn` shares the same texture as
 * `ended` (crosshatch — "complete / locked") because both represent terminal,
 * non-flowing states.  `cancelled` has its own reverse-diagonal pattern
 * ("aborted").
 */
const patternClassMap: Record<StreamStatus, string> = {
  active: "cb-pattern--active",
  draft: "cb-pattern--draft",
  paused: "cb-pattern--paused",
  ended: "cb-pattern--ended",
  withdrawn: "cb-pattern--ended",
  cancelled: "cb-pattern--cancelled",
};

/**
 * BEM-modifier mapping.  `withdrawn` is visually a sub-variant of `ended` so
 * it reuses the ended color token; `cancelled` uses its own distinct token.
 */
const modifierMap: Record<StreamStatus, string> = {
  active: "active",
  draft: "draft",
  paused: "paused",
  ended: "ended",
  withdrawn: "ended",
  cancelled: "cancelled",
};

type StatusBadgeProps = {
  status: StreamStatus;
  className?: string;
};

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const label = statusBadgeCopy[status];
  const modifier = modifierMap[status];
  const patternClass = patternClassMap[status];

  return (
    <span
      aria-label={`Stream status: ${label}`}
      className={[
        "status-badge",
        `status-badge--${modifier}`,
        "cb-pattern",
        patternClass,
        className,
      ].filter(Boolean).join(" ")}
    >
      {/* Decorative shape icon — the text label already conveys the status to
          assistive tech, so the glyph is hidden from screen readers. */}
      <span className={`status-icon status-icon--${status}`} aria-hidden="true">
        {statusBadgeGlyph[status]}
      </span>
      {label}
    </span>
  );
}
