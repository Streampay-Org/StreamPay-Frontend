"use client";

import dynamic from "next/dynamic";

/**
 * SplashScreenWrapper — client boundary for lazily loading SplashScreen.
 *
 * Next.js (App Router) disallows `next/dynamic(..., { ssr: false })` calls
 * inside Server Components — the call site itself must live in a Client
 * Component. `app/layout.tsx` is a Server Component by default, so the
 * dynamic import is isolated here rather than inlined in the layout.
 *
 * This preserves the original intent (issue #85): keep SplashScreen off the
 * critical rendering path and avoid a meaningless server render of a
 * purely client-side overlay.
 */
const SplashScreen = dynamic(() => import("./SplashScreen"), {
  ssr: false,
});

export function SplashScreenWrapper() {
  return <SplashScreen />;
}
