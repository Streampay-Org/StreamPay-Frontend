# Initial Render Performance (issue #85)

This document describes the optimisations shipped in issue #85 to reduce
perceived initial render time for the StreamPay dashboard.

## Problem

Every page load was blocked behind a mandatory 3-second splash screen (2 400 ms
display + 600 ms fade-out) loaded synchronously in the root layout. The home
page also bundled unnecessary client-side JavaScript because of an unneeded
`"use client"` directive.

## Changes

### 1. SplashScreen delay reduction

| Before | After |
|--------|-------|
| Display: 2 400 ms | Display: 400 ms (`SPLASH_DISPLAY_MS`) |
| Fade-out: 600 ms | Fade-out: 300 ms (`SPLASH_FADE_MS`) |
| Total blocking: ~3 s | Total blocking: ~700 ms |

The constants are exported from `app/components/SplashScreen.tsx` so tests can
assert against them as regression guards.

### 2. SplashScreen lazy-loaded

`app/layout.tsx` now imports `SplashScreen` via `next/dynamic` with `ssr: false`:

```tsx
const SplashScreen = dynamic(() => import("./components/SplashScreen"), {
  ssr: false,
});
```

This removes the splash bundle from the critical render path. The browser paints
the actual page content before the splash JavaScript even downloads.

### 3. Home page → React Server Component

`app/page.tsx` no longer has a `"use client"` directive. The only part that
needed the browser (reading `localStorage` for onboarding state) has been moved
to a dedicated lightweight client component: `app/components/OnboardingManager.tsx`.

Impact: the bulk of the home page is now rendered as static HTML on the server
with zero page-level JavaScript shipped to the client.

### 4. Unused import removed

`StreamPrimer` was imported in `app/page.tsx` but never used in JSX. The import
has been removed, reducing the home-page client bundle.

### 5. Image optimisation

`next.config.ts` now includes:

```ts
images: {
  formats: ["image/avif", "image/webp"],
},
compress: true,
```

The 339 KB PNG splash icon will be served as AVIF or WebP to browsers that
support them, significantly reducing the asset size on the wire.

## Testing

Regression coverage is provided by:

- `app/components/SplashScreen.test.tsx` — timing constants cannot silently
  regress above the specified thresholds; render and unmount lifecycle verified.
- `app/components/OnboardingManager.test.tsx` — localStorage read/write and
  dismiss flow covered.
- `app/page.test.tsx` — full RSC render suite; guards that `StreamPrimer` is not
  re-introduced.

## Measuring the impact

Use the browser DevTools **Performance** tab or Lighthouse to compare:

| Metric | Expected direction |
|--------|-------------------|
| First Contentful Paint (FCP) | ↓ (no splash blocking first paint) |
| Time to Interactive (TTI) | ↓ (less JS on home page) |
| Total Blocking Time (TBT) | ↓ (smaller client bundle) |
| Largest Contentful Paint (LCP) | ↓ (AVIF/WebP images load faster) |
