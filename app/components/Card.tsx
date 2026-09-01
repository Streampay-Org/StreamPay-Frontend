"use client";

import React, { PropsWithChildren } from "react";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md" | "lg";
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
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
  role,
  tabIndex,
  onKeyDown,
  ...rest
}) => {
  const isClickable = !!onClick;

  return (
    <div
      onClick={isClickable ? onClick : undefined}
      className={`card ${isClickable ? "card--clickable" : ""} ${className}`}
      style={{
        padding: paddingStyles[padding],
        ...rest.style,
      }}
      role={role ?? (isClickable ? "button" : undefined)}
      tabIndex={tabIndex ?? (isClickable ? 0 : undefined)}
      onKeyDown={
        onKeyDown ??
        (isClickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick?.(e as any);
              }
            }
          : undefined)
      }
      {...rest}
    >
      {children}
    </div>
  );
};
