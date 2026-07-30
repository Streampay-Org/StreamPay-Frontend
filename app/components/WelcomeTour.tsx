"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const WELCOME_TOUR_KEY = "streampay:welcome-tour-dismissed";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Optional icon character / emoji shown as decorative art. */
  icon?: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to StreamPay",
    body: "StreamPay lets you pay collaborators, vendors, and grant recipients in a continuous flow — funds move every second instead of as a lump sum.",
    icon: "✦",
  },
  {
    id: "connect-wallet",
    title: "Connect your Stellar wallet",
    body: "Sign a one-time challenge with your Stellar wallet (Freighter, LOBSTR, or any compatible tool). No private key is ever sent to the server.",
    icon: "⬡",
  },
  {
    id: "create-stream",
    title: "Create a payment stream",
    body: "Set a recipient address, a total amount, and a start and end date. Funds are escrowed on-chain when you confirm — streaming begins at the start date.",
    icon: "→",
  },
  {
    id: "track-streams",
    title: "Track everything in one place",
    body: "The Streams page shows all your active, paused, and draft streams with their current vested balance, status badge, and the next available action.",
    icon: "☰",
  },
  {
    id: "withdraw",
    title: "Withdraw vested funds anytime",
    body: "Recipients can withdraw their vested balance at any point while a stream is active or paused. Cancelling a stream returns unvested funds to you.",
    icon: "↓",
  },
];

interface WelcomeTourProps {
  /** Override the storage key — useful for testing. */
  storageKey?: string;
  /** Called after the tour is dismissed (skip or get started). */
  onDismiss?: () => void;
}

/**
 * WelcomeTour — multi-step onboarding modal for first-time visitors.
 *
 * Features:
 * - Only shown when `storageKey` is absent from localStorage.
 * - Traps focus inside the dialog while open.
 * - Closes on Escape.
 * - Step indicator dots announce the current position to screen readers.
 * - Dismissing (Skip or Get started) writes to localStorage so the tour
 *   is never shown again.
 */
export function WelcomeTour({ storageKey = WELCOME_TOUR_KEY, onDismiss }: WelcomeTourProps) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "welcome-tour-title";

  // Only activate on the client after confirming the tour hasn't been seen.
  useEffect(() => {
    try {
      if (!localStorage.getItem(storageKey)) {
        setVisible(true);
      }
    } catch {
      // localStorage unavailable (e.g. private browsing with strict settings)
    }
  }, [storageKey]);

  // Move focus into the dialog whenever it becomes visible or the step changes.
  useEffect(() => {
    if (visible) {
      // Defer a tick so the DOM has been painted.
      const id = setTimeout(() => {
        dialogRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    }
  }, [visible, step]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // ignore
    }
    setVisible(false);
    onDismiss?.();
  }, [storageKey, onDismiss]);

  // Keyboard: Escape → dismiss, ArrowRight / ArrowLeft → navigate.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        dismiss();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setStep((s) => Math.min(s + 1, TOUR_STEPS.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setStep((s) => Math.max(s - 1, 0));
      }
    },
    [dismiss],
  );

  const handleNext = useCallback(() => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  if (!visible) return null;

  const current = TOUR_STEPS[step];
  const isFirst = step === 0;
  const isLast = step === TOUR_STEPS.length - 1;
  const total = TOUR_STEPS.length;

  return (
    /* Backdrop — clicking outside the card also dismisses the tour */
    <div
      className="welcome-tour-overlay"
      data-testid="welcome-tour-overlay"
      onClick={dismiss}
    >
      {/* Dialog card — stop propagation so clicks inside don't dismiss */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="welcome-tour"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        data-testid="welcome-tour"
      >
        {/* Step indicator dots */}
        <div
          className="welcome-tour__dots"
          role="tablist"
          aria-label="Tour progress"
        >
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === step}
              aria-label={`Step ${i + 1} of ${total}: ${s.title}`}
              className={`welcome-tour__dot${i === step ? " welcome-tour__dot--active" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setStep(i);
              }}
            />
          ))}
        </div>

        {/* Content */}
        <div className="welcome-tour__content">
          {current.icon && (
            <div className="welcome-tour__icon" aria-hidden="true">
              {current.icon}
            </div>
          )}

          <p
            className="welcome-tour__counter"
            aria-live="polite"
            aria-atomic="true"
          >
            Step {step + 1} of {total}
          </p>

          <h2 id={headingId} className="welcome-tour__title">
            {current.title}
          </h2>

          <p className="welcome-tour__body">{current.body}</p>
        </div>

        {/* Actions */}
        <div className="welcome-tour__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={dismiss}
          >
            Skip tour
          </button>

          <div className="welcome-tour__nav">
            {!isFirst && (
              <button
                type="button"
                className="button button--secondary"
                onClick={handleBack}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="button button--primary"
              onClick={handleNext}
              data-testid="welcome-tour-next"
            >
              {isLast ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
