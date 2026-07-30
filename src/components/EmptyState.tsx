import React from "react";

export type EmptyStateVariant = "default" | "stream-type-chip";

export interface EmptyStateProps {
  /** The main title of the empty state */
  title: string;
  /** Additional descriptive text */
  description: string;
  /** React element to render as an illustration (e.g. an SVG or emoji) */
  illustration?: React.ReactNode;
  /** Text for the Call To Action button */
  ctaText?: string;
  /** Callback triggered when the CTA button is clicked */
  onCtaClick?: () => void;
  /** Additional CSS class names */
  className?: string;
  /** Test ID for the component */
  testId?: string;
  /**
   * Visual variant. `"stream-type-chip"` tightens padding for inline chip
   * empty states (Issue #1085); `"default"` keeps the full card layout.
   */
  variant?: EmptyStateVariant;
}

/**
 * EmptyState displays a placeholder when there is no data or a disconnected state.
 * Designed to be responsive, accessible, and consistent with dark-mode tokens.
 */
export function EmptyState({
  title,
  description,
  illustration,
  ctaText,
  onCtaClick,
  className = "",
  testId = "empty-state",
  variant = "default",
}: EmptyStateProps) {
  const isChip = variant === "stream-type-chip";

  return (
    <div
      className={`empty-state ${isChip ? "empty-state--stream-type-chip" : ""} ${className}`.trim()}
      data-testid={testId}
      data-variant={variant}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: isChip ? "1.25rem 1rem" : "2rem",
        textAlign: "center",
        backgroundColor: "var(--panel, #1F2937)",
        border: "1px solid var(--border, #374151)",
        borderRadius: isChip ? "0.875rem" : "0.75rem",
        color: "var(--foreground, #F9FAFB)",
        width: "100%",
        maxWidth: isChip ? "20rem" : "24rem",
        margin: "0 auto",
      }}
      role="region"
      aria-label={title}
    >
      {illustration && (
        <div
          className="empty-state__illustration"
          aria-hidden="true"
          style={{ 
            marginBottom: "1rem", 
            fontSize: "4rem", 
            lineHeight: 1,
            color: "var(--muted-light, #9CA3AF)"
          }}
        >
          {illustration}
        </div>
      )}
      <h3
        className="empty-state__title"
        style={{
          fontSize: "1.25rem",
          fontWeight: 600,
          margin: "0 0 0.5rem 0",
        }}
      >
        {title}
      </h3>
      <p
        className="empty-state__description"
        style={{
          fontSize: "0.875rem",
          color: "var(--muted-light, #9CA3AF)",
          marginBottom: "1.5rem",
        }}
      >
        {description}
      </p>
      {ctaText && (
        <button
          className="empty-state__cta empty-state__cta--focus-visible"
          onClick={onCtaClick}
          disabled={!onCtaClick}
          type="button"
          style={{
            padding: "0.75rem 1.5rem",
            borderRadius: "9999px",
            backgroundColor: "var(--primary, #3B82F6)",
            color: "#FFFFFF",
            border: "none",
            fontSize: "0.875rem",
            fontWeight: 500,
            cursor: onCtaClick ? "pointer" : "not-allowed",
            opacity: onCtaClick ? 1 : 0.6,
            transition: "background-color 0.2s, box-shadow 0.15s ease",
          }}
        >
          {ctaText}
        </button>
      )}
    </div>
  );
}

export default EmptyState;
