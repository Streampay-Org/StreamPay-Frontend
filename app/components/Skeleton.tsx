"use client";

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
 * Skeleton component to show loading states with design-token parity.
 * Implements WCAG 2.1 AA accessibility by hiding the presentation element from screen readers.
 */
export const Skeleton = ({
  width,
  height,
  circle = false,
  className = "",
  variant,
}: SkeletonProps) => {
  // Compute classes with variant priority. Base '.skeleton' class handles dark-mode styles via CSS variables.
  const variantClass = variant ? `skeleton--${variant}` : "";
  const finalClassName = `skeleton ${variantClass} ${className}`.trim();

  // For backward compatibility, if no variant is provided and no explicit width/height is given, fallback to original defaults
  const finalWidth = width ?? (variant ? undefined : "100%");
  const finalHeight = height ?? (variant ? undefined : "1rem");

  return (
    <div
      className={finalClassName}
      aria-hidden="true"
      style={{
        width: typeof finalWidth === "number" ? `${finalWidth}px` : finalWidth,
        height: typeof finalHeight === "number" ? `${finalHeight}px` : finalHeight,
        borderRadius: circle ? "50%" : undefined,
      }}
    />
  );
};
