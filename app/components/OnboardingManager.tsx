"use client";

import { useEffect, useState } from "react";
import { WelcomeTour, WELCOME_TOUR_KEY } from "./WelcomeTour";

const ONBOARDING_KEY = "streampay_onboarding_dismissed";

/**
 * OnboardingManager — isolated client component that reads `localStorage`
 * and surfaces the onboarding prompt when a first-time visitor is detected.
 *
 * Extracted from `app/page.tsx` (issue #85) so the parent page can remain
 * a React Server Component.
 *
 * On a user's very first visit (neither banner nor tour dismissed):
 *   - The WelcomeTour modal is shown.
 *   - The banner is suppressed until the tour is completed/skipped, to
 *     avoid competing UI.
 *
 * On subsequent visits where only the banner has not been dismissed:
 *   - The plain onboarding banner is shown.
 */
export default function OnboardingManager() {
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [tourVisible, setTourVisible] = useState(false);

  useEffect(() => {
    const bannerDismissed = localStorage.getItem(ONBOARDING_KEY);
    const tourDismissed = localStorage.getItem(WELCOME_TOUR_KEY);

    if (!tourDismissed) {
      // First-ever visit — show the full tour; suppress the plain banner.
      setTourVisible(true);
    } else if (!bannerDismissed) {
      // Tour already seen but banner not yet dismissed.
      setOnboardingVisible(true);
    }
  }, []);

  const handleBannerDismiss = () => {
    setOnboardingVisible(false);
    localStorage.setItem(ONBOARDING_KEY, "true");
  };

  // When the tour is dismissed mark the banner dismissed too so it doesn't
  // immediately appear after the modal closes.
  const handleTourDismissed = () => {
    setTourVisible(false);
    try {
      localStorage.setItem(ONBOARDING_KEY, "true");
    } catch {
      // ignore
    }
  };

  return (
    <>
      {tourVisible && (
        <WelcomeTour
          storageKey={WELCOME_TOUR_KEY}
          onDismiss={handleTourDismissed}
        />
      )}

      {onboardingVisible && (
        <aside
          className="onboarding-banner"
          role="note"
          aria-label="Welcome to StreamPay"
          data-testid="onboarding-banner"
        >
          <p className="onboarding-banner__message">
            Welcome to StreamPay — create and manage real-time payment streams on
            Stellar.
          </p>
          <button
            type="button"
            className="onboarding-banner__dismiss"
            onClick={handleBannerDismiss}
            aria-label="Dismiss welcome message"
          >
            Dismiss
          </button>
        </aside>
      )}
    </>
  );
}
