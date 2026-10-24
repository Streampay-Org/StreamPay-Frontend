"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/app/hooks/useFocusTrap";
import { safeStorage } from "@/app/lib/safeStorage";

export const WELCOME_TOUR_KEY = "streampay:welcome-tour-dismissed";
export const WELCOME_TOUR_SESSION_KEY = "streampay:welcome-tour-session-dismissed";

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
    icon: "✶",
  },
  {
    id: "connect-wallet",
    title: "Connect your Stellar wallet",
    body: "Sign a one-time challenge with your Stellar wallet (Freighter, LOBSTR, or any compatible tool). No private key is ever sent to the server.",
    icon: "⡭",
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
  /** Override the session storage key — useful for testing. */
  sessionKey?: string;
  /** Called after the tour is dismissed (skip or get started). */
  onDismiss?: () => void;
  /** Called when the tour is dismissed via backdrop click (session-only). */
  onSessionDismiss?: () => void;
}

/**
 * WelcomeTour — multi-step onboarding modal for first-time visitors.
 *
 * Features:
 * - Only shown when `storageKey` is absent from localStorage.
 * - Traps focus inside the dialog while open (Tab / Shift+Tab).
 * - Closes on Escape and restores focus to the previous element.
 * - Step indicator dots announce the current position to screen readers.
 * - Dismissing (Skip or Get started) writes to localStorage so the tour
 *   is never shown again. A backdrop click only dismisses for the session.
 */
export function WelcomeTour({
  storageKey = WELCOME_TOUR_KEY,
  sessionKey = WELCOME_TOUR_SESSION_KEY,
  onDismiss,
  onSessionDismiss,
}: WelcomeTourProps) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingId = "welcome-tour-title";

  // Only activate on the client after confirming the tour hasn't been seen.
  // Decision is made in an effect to avoid hydration mismatches.
  useEffect(() => {
    const permanentlyDismissed = safeStorage.getItem(storageKey, "local");
    const sessionDismissed = safeStorage.getItem(sessionKey, "session");
    if (!permanentlyDismissed && !sessionDismissed) {
      setVisible(true);
    }
  }, [storageKey, sessionKey]);

  const dismissPermanent = useCallback(() => {
    safeStorage.setItem(storageKey, "1", "local");
    setVisible(false);
    onDismiss?.();
  }, [storageKey, onDismiss]);

  const dismissSession = useCallback(() => {
    safeStorage.setItem(sessionKey, "1", "session");
    setVisible(false);
    onSessionDismiss?.();
  }, [sessionKey, onSessionDismiss]);

  // Real focus trap: Tab / Shift+Tab cycle within the dialog, Escape dismisses,
  // and focus is restored on deactivation.
  useFocusTrap({
    isActive: visible,
    containerRef: dialogRef,
    onEscape: dismissPermanent,
  });

  // Keyboard: Arrow keys navigate steps only when focus is on the dialog
  // container or on a dot. Arrow keys on buttons are left alone.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const target = e.target as HTMLElement | null;
    const isDot = !!target?.closest?.("[data-tour-dot]");
    const isContainer = target === dialogRef.current;
    if (!isDot && !isContainer) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setStep((s) => Math.min(s + 1, TOUR_STEPS.length - 1));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setStep((s) => Math.max(s - 1, 0));
    }
  }, []);

  const handleNext = useCallback(() => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismissPermanent();
    }
  }, [step, dismissPermanent]);

  const handleBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  if (!visible) return null;

  const current = TOUR_STEPs[step];
  const isFirst = step === 0;
  const isLast = step === TOUR_STEPS.length - 1;
  const total = TOUR_STEPS.length;

  return (
    /* Backdrop — clicking outside the card dismisses for this session only */
    <div
      className="welcome-tour-overlay"
      data-testid="welcome-tour-overlay"
      onClick={dismissSession}
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
        {/* Step indicator dots. These are navigation controls, not tabs:
            there is no tabpanel, and marking them role="tab" without aria-controls
            is an axe violation. Use a group of buttons with aria-current instead. */}
        <div
          className="welcome-tour__dots"
          role="group"
          aria-label="Tour progress"
        >
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              data-tour-dot="true"
              aria-current={i === step ? "step" : undefined}
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
            onClick={(e) => {
              e.stopPropagation();
              dismissPermanent();
            }}
          >
            Skip tour
          </button>

          <div className="welcome-tour__nav">
            {!isFirst && (
              <button
                type="button"
                className="button button--secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  handleBack();
                }}
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="button button--primary"
              onClick={(e) => {
                e.stopPropagation();
                handleNext();
              }}
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