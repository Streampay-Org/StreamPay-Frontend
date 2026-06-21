"use client";

import React, { PropsWithChildren } from "react";

/** Props for the {@link Card} component. */
interface CardProps {
  /** Inner padding size. Defaults to `"md"` (1 rem). Use `"none"` to opt out
   *  of padding entirely when the card wraps a full-bleed image or table. */
  padding?: "none" | "sm" | "md" | "lg";
  /** When provided the card becomes keyboard- and pointer-interactive.
   *  The `card--clickable` CSS class is added automatically. */
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Extra CSS class names appended to the card element. */
  className?: string;
}

const paddingStyles = {
  none: "0",
  sm: "0.75rem",
  md: "1rem",
  lg: "1.5rem",
};

export const Card: React.FC<PropsWithChildren<CardProps>> = ({
  children,
  padding = "md",
  onClick,
  className = "",
}) => {
  const isClickable = !!onClick;

  return (
    <div
      onClick={isClickable ? onClick : undefined}
      className={`card ${isClickable ? "card--clickable" : ""} ${className}`}
      style={{
        padding: paddingStyles[padding],
      }}
    >
      {children}
    </div>
  );
};
