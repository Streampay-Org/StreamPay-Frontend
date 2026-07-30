"use client";

/**
 * StepIndicator
 *
 * Step progress indicator for the create-stream wizard.
 *
 * ## Accessibility (WCAG 2.1 AA)
 * - Visible steps are a `nav`/`ol` list; the current step carries
 *   `aria-current="step"` per the WAI-ARIA breadcrumb/steps pattern.
 * - A visually hidden (`.sr-only`) `role="progressbar"` mirrors the same
 *   state as `aria-valuenow` / `aria-valuemin` / `aria-valuemax`, with
 *   `aria-valuetext` giving screen readers a concise "Step X of Y: <label>"
 *   summary — mirrors the pattern used by `StreamProgress`.
 * - Markers and connectors are `aria-hidden`; state is not conveyed by
 *   color/icon alone since the label and (for the current step) description
 *   remain visible text.
 */

import React from "react";

export interface Step {
  id: string;
  label: string;
  description?: string;
}

interface StepIndicatorProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export function StepIndicator({ steps, currentStep, className = "" }: StepIndicatorProps) {
  const totalSteps = steps.length;
  const currentLabel = steps[currentStep]?.label;
  const stepPosition = currentStep + 1;

  return (
    <nav aria-label="Progress" className={`step-indicator ${className}`.trim()}>
      {totalSteps > 0 && (
        // Visually hidden progressbar: the visible ol/li list already conveys
        // progress sighted users via aria-current, but assistive tech benefits
        // from a concise, standards-based "step X of Y" announcement.
        <div
          role="progressbar"
          aria-valuenow={stepPosition}
          aria-valuemin={1}
          aria-valuemax={totalSteps}
          aria-valuetext={`Step ${stepPosition} of ${totalSteps}${currentLabel ? `: ${currentLabel}` : ""}`}
          aria-label="Wizard progress"
          className="step-indicator__sr-progress sr-only"
        />
      )}
      <ol className="step-indicator__list">
        {steps.map((step, index) => {
          const isCompleted = index < currentStep;
          const isCurrent = index === currentStep;
          const isUpcoming = index > currentStep;

          const stateClass = isCompleted ? "completed" : isCurrent ? "current" : "upcoming";

          return (
            <li
              key={step.id}
              className={`step-indicator__step step-indicator__step--${stateClass}`}
              aria-current={isCurrent ? "step" : undefined}
            >
              <div className="step-indicator__marker" aria-hidden="true">
                {isCompleted ? (
                  <svg
                    className="step-indicator__check"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span className="step-indicator__number">{index + 1}</span>
                )}
              </div>

              <div className="step-indicator__content">
                <span className="step-indicator__label">{step.label}</span>
                {step.description && (
                  <span className="step-indicator__desc">{step.description}</span>
                )}
              </div>

              {index < steps.length - 1 && (
                <div className="step-indicator__connector" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
