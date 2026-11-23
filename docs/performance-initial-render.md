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

## Lighthouse CI

`lighthouserc.json` audits the home page and `/streams` against a production
server. It requires a successful `npm run build` and starts the app on port 3000
with `npm run start`.

Run the same validation locally:

```bash
npm run build
npx --yes @lhci/cli@0.14 autorun
```

LHCI keeps reports in `.lighthouseci/`; that directory is ignored and must not be
committed. Run the command twice and compare the medians before changing a
budget. If results vary by more than roughly 10% for a metric, widen the
threshold to cover the observed variance rather than chasing a single run.

### Budgets

The blocking budgets are:

| Budget | Threshold | Rule |
|--------|-----------|------|
| Performance | `>= 0.8` | error |
| Accessibility | `>= 0.9` | error |
| Largest Contentful Paint | `<= 3300 ms` | warning |
| Cumulative Layout Shift | `<= 0.1` | warning |

The current 3300 ms LCP warning is based on a local three-run baseline. The
production build could not complete in this checkout because unrelated existing
API-route syntax/build errors were reported under `app/api/`; therefore the
values below are diagnostic development-server baselines, not a production
baseline. They should be re-measured after the build blocker is resolved.

| URL | Performance scores (3 runs) | Accessibility scores (3 runs) | LCP range | CLS range |
|-----|-----------------------------|-------------------------------|-----------|-----------|
| `/` | 0.53, 0.67, 0.67 | 0.96, 0.96, 0.96 | 3208.6–3269.0 ms | 0.0000–0.0000 |
| `/streams` | 0.64, 0.65, 0.65 | 0.93, 0.93, 0.93 | 3373.7–3467.4 ms | 0.0000–0.0000 |

No Lighthouse accessibility failure was found in the measured runs. LCP warnings
remain as follow-ups and should not be blocked behind the metric baseline:
production-style measurement and caching may change the values.

### Budget tuning

Adjust `lighthouserc.json` only after at least two complete runs. Base category
budgets on the lower end of the stable measured scores, and tune LCP/CLS from
the observed worst stable medians. Keep performance and accessibility assertions
as errors, while retaining LCP and CLS as warnings. Never lower a score solely
to make a failing CI run pass.

### Proposed GitHub Actions workflow

The maintainer will apply this file separately; it is intentionally not added to
`.github/workflows/` by this PR.

```yaml
name: Lighthouse

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  STELLAR_NETWORK: testnet
  JWT_SECRET: streampay-dev-secret-do-not-use-in-prod
  NODE_ENV: test
  CI: true

jobs:
  lighthouse:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
        env:
          STELLAR_NETWORK: testnet
          JWT_SECRET: streampay-dev-secret-do-not-use-in-prod
          STREAMPAY_ADMIN_ADDRESS: GADMIN_DEV_PLACEHOLDER_DO_NOT_USE_IN_PROD
          WEBHOOK_SECRET: dev-webhook-secret-do-not-use-in-prod-1234567890
          AUDIT_CHAIN_KEY: dev-audit-chain-key-do-not-use-in-prod
          NODE_ENV: production
      - name: Run Lighthouse CI
        run: npx --yes @lhci/cli@0.14 autorun
```
