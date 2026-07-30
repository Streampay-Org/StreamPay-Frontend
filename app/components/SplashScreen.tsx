"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

/**
 * SplashScreen — branded loading overlay shown on initial app mount.
 *
 * Displays the StreamPay logo with a pulsing glow, animated tagline,
 * and a smooth fade-out transition once the page is ready.
 *
 * The splash auto-dismisses after a minimum display duration (400 ms)
 * so the brand impression registers before yielding to the dashboard
 * without blocking perceived initial render time.
 *
 * Performance notes:
 * - Delay reduced from 2400 ms → 400 ms (issue #85).
 * - Fade-out reduced from 600 ms → 300 ms.
 * - Component is loaded lazily via next/dynamic in layout.tsx so it
 *   is excluded from the critical rendering path entirely.
 * - Supports prefers-reduced-motion: all animations are disabled when
 *   reduced motion is requested.
 */

/** Minimum time (ms) the splash is visible before it begins fading out. */
export const SPLASH_DISPLAY_MS = 400;
/** Duration (ms) of the CSS fade-out transition. */
export const SPLASH_FADE_MS = 300;

export default function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [fadeOut, setFadeOut] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    // Detect reduced motion preference
    if (typeof window !== "undefined" && window.matchMedia) {
      const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      setReduceMotion(mediaQuery.matches);
    }

    const timer = setTimeout(() => {
      setFadeOut(true);
      // Allow the CSS fade-out transition to finish before unmounting
      setTimeout(() => setVisible(false), SPLASH_FADE_MS);
    }, SPLASH_DISPLAY_MS);

    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div
      className={`splash-screen ${fadeOut ? "splash-screen--exit" : ""}`}
      role="status"
      aria-label="Loading StreamPay"
      id="splash-screen"
    >
      {/* Animated background orbs */}
      {!reduceMotion && (
        <>
          <div className="splash-orb splash-orb--1" aria-hidden="true" />
          <div className="splash-orb splash-orb--2" aria-hidden="true" />
          <div className="splash-orb splash-orb--3" aria-hidden="true" />
        </>
      )}

      <div className="splash-content">
        {/* Logo with glow ring */}
        <div className="splash-logo-wrap">
          {!reduceMotion && <div className="splash-logo-glow" aria-hidden="true" />}
          <Image
            src="/assets/splash-icon.png"
            alt="StreamPay logo"
            className="splash-logo"
            width={120}
            height={120}
          />
        </div>

        {/* Brand name */}
        <h1 className="splash-title">
          <span className="splash-title__stream">Stream</span>
          <span className="splash-title__pay">Pay</span>
        </h1>

        {/* Tagline */}
        <p className="splash-tagline">Real-time payments on Stellar</p>

        {/* Loading indicator */}
        {!reduceMotion && (
          <div className="splash-loader" aria-hidden="true">
            <div className="splash-loader__bar" />
          </div>
        )}
      </div>
    </div>
  );
}
