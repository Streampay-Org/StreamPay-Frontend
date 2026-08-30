"use client";

import { useEffect, useState } from "react";

/**
 * Tracks browser connectivity via the `online` / `offline` window events.
 *
 * The app refuses to present stream-mutation success when the browser reports
 * it is offline, because a mutation that cannot reach the server cannot be
 * confirmed. This hook is the single source of truth for that decision.
 *
 * Invariants:
 * - SSR-safe: defaults to `true` before hydration so first render never
 *   blocks a legitimately-online user; the real value is applied on mount.
 * - Deterministic: the value is `navigator.onLine` at mount and thereafter
 *   only changes in response to `online` / `offline` window events.
 * - Cleanup: listeners are removed on unmount to avoid leaked subscriptions.
 */
export function isBrowserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function useNetworkStatus(): { isOnline: boolean } {
  const [isOnline, setIsOnline] = useState<boolean>(isBrowserOnline);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return { isOnline };
}