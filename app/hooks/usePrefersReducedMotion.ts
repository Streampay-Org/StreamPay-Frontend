"use client";

import { useEffect, useState } from "react";

/**
 * @media query constant used for the initial state and the live listener.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Tracks the user's `prefers-reduced-motion` setting.
 *
 * Returns `true` when the user has requested reduced motion. SSR-safe: defaults
 * to `false` on the server (and before hydration) and updates live if the
 * preference changes.
 */
export function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    setPrefersReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    }

    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return prefersReduced;
}