/**
 * Skeleton — simple loading placeholder.
 *
 * Variants map to the global `.skeleton--*` CSS classes in `app/globals.css`
 * which use the `--skeleton-base` / `--skeleton-shine` design tokens and
 * respect `prefers-reduced-motion` automatically.
 *
 * This file is consumed from both `src/` contexts and re-exported via
 * `app/components/Skeleton.tsx`.  Keep the two in sync.
 */

import React from "react";
import styles from "./Skeleton.module.css";

export type SkeletonVariant =
  | "title"
  | "text"
  | "badge"
  | "label"
  | "value"
  | "button";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Override rendered width (e.g. "50%", 120, "4rem"). */
  width?: string | number;
  /** Override rendered height (e.g. "2rem", 40). */
  height?: string | number;
  /** Render as a circle (sets border-radius to 50 %). */
  circle?: boolean;
  /** Additional CSS classes forwarded to the root element. */
  className?: string;
  /**
   * Pre-defined variant that selects the matching `.skeleton--*` class from
   * `globals.css`, giving size and shape in one prop.
   */
  variant?: SkeletonVariant;
}

/**
 * Renders an animated shimmer placeholder.
 *
 * - Always `aria-hidden="true"` so screen-readers skip it.
 * - Animation is suppressed when `prefers-reduced-motion: reduce` is set via
 *   the `@media` rule in `Skeleton.module.css`.
 */
export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  circle = false,
  className = "",
  variant,
  style,
  ...rest
}) => {
  const variantClass = variant ? `skeleton--${variant}` : "";

  // When a variant is active, the CSS class supplies the default size;
  // only apply inline width/height when the caller explicitly provides them.
  const resolvedWidth = width ?? (variant ? undefined : "100%");
  const resolvedHeight = height ?? (variant ? undefined : "1rem");

  const finalClassName =
    `${styles.skeleton} skeleton ${variantClass} ${className}`.trim();

  return (
    <div
      className={finalClassName}
      aria-hidden="true"
      style={{
        width:
          typeof resolvedWidth === "number"
            ? `${resolvedWidth}px`
            : resolvedWidth,
        height:
          typeof resolvedHeight === "number"
            ? `${resolvedHeight}px`
            : resolvedHeight,
        borderRadius: circle ? "50%" : undefined,
        ...style,
      }}
      {...rest}
    />
  );
};

export default Skeleton;
