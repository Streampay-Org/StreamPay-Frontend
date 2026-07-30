import type { ReactNode } from "react";
import { EmptyIllustration } from "./EmptyIllustration";
import { StreamProgressEmptyIllustration } from "./StreamProgressEmptyIllustration";

export type EmptyStateVariant = "streams" | "generic" | "stream-progress";

type EmptyStateProps = {
  eyebrow: string;
  title: string;
  description: string;
  actionLabel: string;
  /** Optional handler invoked when the primary action button is pressed. */
  onAction?: () => void;
  /**
   * Optional guidance bullets rendered as a structured list of "what you'll
   * set up" steps below the illustration, above the CTA. Convenience prop
   * used by `StateTriad.empty.guidanceSteps`; falls back to `children` if
   * both are provided.
   */
  guidanceSteps?: readonly string[];
  /**
   * Visual variant. `"streams"` (default) renders the v7 StreamRow ghost-row
   * SVG illustration; `"stream-progress"` renders the themed StreamProgress empty SVG;
   * `"generic"` omits the illustration for narrower or non-list contexts.
   */
  variant?: EmptyStateVariant;
  /** Arbitrary supporting content rendered between copy and the CTA. */
  children?: ReactNode;
  /** Additional CSS classes forwarded to the outer <section>. */
  className?: string;
};

/**
 * EmptyState
 *
 * Accessible primary-empty pattern.  Renders a heading, description, CTA,
 * and (in the `"streams"` variant) the v7-themed `EmptyIllustration` which
 * visually echoes the color-blind pattern tiles used on the real StreamRow
 * cards — so the empty state feels continuous with the populated list.
 *
 * ### Accessibility
 * - Section carries an `aria-labelledby` pointing at the H2.
 * - Illustration is `aria-hidden` (decorative); the text copy conveys meaning.
 * - CTA is a real `<button>` so it participates in tab order; when
 *   `onAction` is missing the button stays rendered but is `disabled` so
 *   accidental clicks can't happen.
 */
export function EmptyState({
  eyebrow,
  title,
  description,
  actionLabel,
  onAction,
  guidanceSteps,
  variant = "streams",
  children,
  className = "",
}: EmptyStateProps) {
  const hasGuidance = Array.isArray(guidanceSteps) && guidanceSteps.length > 0;
  const hasSupporting = Boolean(children) || hasGuidance;
  const outerClass = [
    "empty-state",
    variant === "streams" ? "empty-state--streams" : variant === "stream-progress" ? "empty-state--stream-progress" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={outerClass} aria-labelledby="empty-state-title">
      {variant === "streams" ? (
        <div className="empty-state__illustration" aria-hidden="true">
          <EmptyIllustration
            className="empty-state__illustration-svg"
            decorative
          />
        </div>
      ) : variant === "stream-progress" ? (
        <div className="empty-state__illustration" aria-hidden="true">
          <StreamProgressEmptyIllustration
            className="empty-state__illustration-svg"
            decorative
          />
        </div>
      ) : null}

      <div className="empty-state__content">
        <p className="empty-state__eyebrow">{eyebrow}</p>
        <h2 className="empty-state__title" id="empty-state-title">
          {title}
        </h2>
        <p className="empty-state__description">{description}</p>
      </div>

      {hasSupporting ? (
        <div className="empty-state__supporting">
          {children}
          {hasGuidance ? (
            <>
              {!children ? (
                <p className="empty-state__supporting-title">
                  What you&apos;ll set up
                </p>
              ) : null}
              <ul className="empty-state__supporting-list">
                {guidanceSteps.map((step, i) => (
                  <li key={`${step.slice(0, 8)}-${i}`}>{step}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      <button
        className="button button--primary"
        type="button"
        onClick={onAction}
      >
        {actionLabel}
      </button>
    </section>
  );
}
