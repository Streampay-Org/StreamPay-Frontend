# Changelog

## Unreleased

### Changed
- `POST /api/webhooks` now applies strict Zod body validation. Requests must include a non-empty `eventType`; unknown top-level fields now return `400 INVALID_INPUT`.

All notable API changes to StreamPay are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
API versioning follows the policy in [README.md#api-versioning](README.md#api-versioning).

---

## [Unreleased]

### Fixed
- **CreateStreamForm responsive breakpoints** (#1042 v7): Audited and fixed
  responsive layout for `CreateStreamForm` (`app/streams/new/page.tsx`) across
  narrow, mobile, and wide viewports. The Amount+Token grid now collapses to a
  single column below 360px (`22.4375rem`), action buttons stack vertically on
  extra-narrow screens, and the multi-recipient CTA banner adapts with tighter
  padding on small viewports. Introduced `.csf-field-row`, `.csf-actions`,
  `.csf-cta-banner`, and `.csf-section` CSS classes with media-query overrides
  in `globals.css`. Added `data-testid` attributes for each responsive container
  and a focused test suite (`page.resp.test.tsx`) covering class presence,
  structural integrity, and mobile bottom-sheet behaviour. All 19
  CreateStreamForm tests pass.

### Performance (issue #85 — reduce initial render time)
- **SplashScreen delay reduced**: mandatory display time cut from 2 400 ms to
  400 ms and fade-out from 600 ms to 300 ms, removing ~2.3 s of forced
  blocking before the app becomes interactive.
- **SplashScreen lazy-loaded**: the branded overlay is now loaded via
  `next/dynamic` with `ssr: false`, removing it from the critical render path
  entirely. First paint of the actual page content no longer waits for the
  splash bundle.
- **Home page converted to React Server Component**: `app/page.tsx` no longer
  carries `"use client"`. The `localStorage`-dependent onboarding state is
  isolated in a new `OnboardingManager` client component, keeping the bulk of
  the page as a zero-JS static render.
- **Unused import removed**: `StreamPrimer` was imported but never rendered in
  `app/page.tsx`; the import has been removed to reduce the client bundle.
- **Image optimisation enabled**: `next.config.ts` now specifies
  `images.formats: ["image/avif", "image/webp"]` so the 339 KB PNG splash
  icon (and any future images) are served in modern formats to supporting
  browsers.
- **HTTP compression enabled**: `compress: true` added to `next.config.ts`
  (gzip/brotli for all responses).

### Added
- Cursor pagination on `GET /api/reconciliation` over stable
  `(created_at, id)` ordering with `meta.nextCursor` / `meta.hasNext`.
  Malformed cursors return `422 INVALID_CURSOR`. Documented in
  `docs/api/reconciliation-cursor.md`.
- MRU (most-recently-used) wallet ordering on the connect modal: the
  provider a user picked last surfaces at the top of `WalletModal`,
  persisted under the `streampay_mru_wallet` `localStorage` key via
  `getMRUWalletId` / `setMRUWalletId` / `getSortedProviders` in
  `app/state/walletPrefs.ts`. Stale ids and SSR are tolerated; the
  connect flow never breaks because of a missing preference. Backed by
  focused unit tests in `app/state/walletPrefs.test.ts` and documented in
  `docs/mru-wallet-ordering.md`.
- `lib/chaos.ts` — fault-injection middleware for chaos tests. Lets test
  suites inject latency, error responses, or request aborts at configurable
  rates (defaults disabled; opt in via `CHAOS_ENABLED=true` or programmatic
  override). Activated per-request through `withChaosMiddleware(request,
  handler, options?)`. Honors path-prefix and HTTP-method allowlists, exposes
  every standard env knob (`CHAOS_LATENCY_RATE`, `CHAOS_ERROR_RATE`,
  `CHAOS_ABORT_RATE`, `CHAOS_MIN_LATENCY_MS`, `CHAOS_MAX_LATENCY_MS`,
  `CHAOS_ERROR_STATUS`, `CHAOS_ERROR_CODE`, `CHAOS_ERROR_MESSAGE`,
  `CHAOS_PATH_PREFIXES`, `CHAOS_METHODS`, `CHAOS_SEED`), and emits the
  standard `{ error: { code, message, request_id } }` envelope on injected
  errors with `x-chaos-fault` / `x-chaos-<kind>-ms` markers on the wire
  (test-only — do not rely on in production).
- `lib/chaos.test.ts` — Jest unit suite targeting >=90% line coverage
  (currently 97.23% lines / 100% funcs / 90.22% branches). Locks the pure
  decision function, the resolver priority chain, every validation branch,
  and the middleware dispatch surface.

### Security
- Per-user rate limit on `GET|POST /api/webhooks`: 30 requests/min per
  caller (API key / JWT wallet / IP), returning the standard `429`
  envelope with `Retry-After`. Override via `WEBHOOK_RATE_LIMIT`.
- Per-user rate limit on `POST /api/exports`: 5 requests/min per
  authenticated wallet, checked after JWT verification so forged tokens
  cannot spend a victim's budget, returning the standard `429` envelope with
  `Retry-After`. Rate-limit buckets are now keyed per limit tier
  (read/write/export), so throttling one endpoint class can no longer drain
  a user's allowance for another.
- Wallet auth IP rate limiting on `GET|POST /api/auth/wallet` now returns the
  canonical `{ error: { code, message, request_id } }` envelope on 429, echoes
  `x-request-id`, and emits structured `wallet_ip_rate_limit_exceeded` logs
  with correlation IDs. OpenAPI documents the login (5/min) and challenge
  (20/min) IP limits.
- Boundary validation rejects NaN/Infinity rates, negative latency, 1xx/2xx/
  3xx status codes, malformed path prefixes (whitespace or control chars),
  empty/whitespace `errorCode` / `errorMessage`, and non-integer seeds.
- Disabled by default — every config is validated but no fault is ever
  injected unless the operator explicitly opts in.
- Centralized accessible toast queue (`ToastProvider`, `useToast`) with
  severity icons, auto-dismiss, queue limits, and `role="status"` live
  region announcements per WCAG 2.1 AA.
- A shared keyboard focus-visible layer for interactive controls so focus
  indicators remain clear in both light and dark themes.
- Request fingerprinting for fraud signals on all `/api/*` routes. Edge
  middleware computes a stable SHA-256 hash from non-volatile request signals
  (method, path, client IP, User-Agent, Accept-Language, Accept-Encoding) and
  forwards it via the internal `x-request-fingerprint` header. Fingerprint
  observations are written to the append-only audit log with correlation IDs,
  and privileged stream audit events now include `requestFingerprint` metadata.

### Changed
- The streams list now surfaces a distinct filtered-results empty state when the
  current view has no matches, with clearer guidance to clear filters and return
  to the broader streams list.
- `StreamProgress` now emits shared color-blind pattern classes on its fill so
  stream state remains distinguishable beyond color alone.
- `StreamTypeChip` now uses shared design-token spacing, typography, and focus
  styling for more consistent rendering across light, dark, and high-contrast
  themes.

### Fixed
- `GET /api/orgs/:orgId/members` and `POST /api/orgs/:orgId/members` now return
  `404 ORG_NOT_FOUND` when the organization does not exist, instead of an
  unhandled `500` caused by accessing an undefined legacy store.

## [2.0.0] — 2026-04-28

### Added
- `/api/v2/streams` and `/api/v2/streams/:id` — stream CRUD endpoints with
  the v2 response shape (see breaking changes below).
- `allowed_actions` array field replaces `nextAction` string, allowing a
  stream to surface multiple permitted actions simultaneously.
- Structured `settlement` object (`{ tx_hash, settled_at }`) replaces the
  flat `settlementTxHash` string; always present, `null` when not yet settled.
- `created_at` / `updated_at` snake_case date fields aligned with
  Stellar Horizon conventions (replaces `createdAt` / `updatedAt`).
- `/api/v1/*` paths now serve `Deprecation` and `Sunset` response headers
  on every response (RFC 9745).
- `/api/v1/*` will return `410 Gone` with a machine-readable body and
  migration link after **2026-12-31** (245-day notice from deprecation date).
- `docs/api-v2-migration.md` — complete migration guide for wallet partners.
- `docs/deprecation-notice-template.md` — comms template for future
  major deprecations.
- CI contract tests (`v1-contract.test.ts`) pin the v1 response shape
  for the full deprecation window.

### Breaking changes (v1 → v2)

| Field (v1) | Field (v2) | Notes |
|---|---|---|
| `nextAction: string` | `allowed_actions: string[]` | Always an array; empty when no action is available. |
| `createdAt: string` | `created_at: string` | ISO 8601, same value. |
| `updatedAt: string` | `updated_at: string` | ISO 8601, same value. |
| `settlementTxHash?: string` | `settlement: { tx_hash, settled_at } \| null` | Always present; `null` before settlement. |
| `partnerId?: string` | `partner_id?: string` | snake_case rename; value unchanged. |

### Deprecated
- `/api/streams/*` (unversioned paths) — these are the v1 handlers.
  Continue to work for the deprecation window; migrate to `/api/v2/streams/*`.
- `/api/v1/streams/*` — URL alias for the above.
- **Sunset: 2026-12-31.** After this date all `/api/v1/*` paths return
  `410 Gone`.

---

## [1.0.0] — 2026-01-15 (baseline)

Initial stable stream API release.

### Endpoints
- `GET  /api/streams` — list streams with cursor pagination
- `POST /api/streams` — create a stream (returns `draft`)
- `GET  /api/streams/:id` — get a single stream
- `DELETE /api/streams/:id` — delete a draft/ended/withdrawn stream
- `POST /api/streams/:id/start` — draft → active
- `POST /api/streams/:id/pause` — active → paused
- `POST /api/streams/:id/stop` — active|paused → ended
- `POST /api/streams/:id/settle` — active|paused → ended (with on-chain settlement)
- `POST /api/streams/:id/withdraw` — ended → withdrawn

### Response shape (v1)
```json
{
  "data": {
    "id": "stream-abc123",
    "recipient": "GABC...",
    "rate": "100 XLM / month",
    "schedule": "Pays every 30 days",
    "status": "active",
    "nextAction": "pause",
    "createdAt": "2026-01-15T10:00:00.000Z",
    "updatedAt": "2026-01-15T10:00:00.000Z",
    "settlementTxHash": "tx-abc..."
  },
  "links": { "self": "/api/v1/streams/stream-abc123" }
}
```

---

[Unreleased]: https://github.com/Streampay-Org/StreamPay-Frontend/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Streampay-Org/StreamPay-Frontend/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/Streampay-Org/StreamPay-Frontend/releases/tag/v1.0.0
