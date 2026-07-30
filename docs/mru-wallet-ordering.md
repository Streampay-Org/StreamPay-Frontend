# MRU Wallet Ordering

`WalletModal` reorders the list of available wallet providers so the **most
recently used** provider appears first. This snippet explains what that means,
where it lives in the code, and edge cases worth knowing before changing it.

## Goal

Users on Stellar frequently come back to the same few wallets (Freighter,
xBull, Albedo, Rabet). Surfacing the wallet they used *last time* at the top
of the connect modal lets them connect in one click instead of scanning the
list.

## Behavior

1. `<WalletModal />` opens.
2. It calls `getSortedProviders()` (from [`app/state/walletPrefs.ts`](../app/state/walletPrefs.ts)).
3. `getSortedProviders()` reads the MRU id from `localStorage` under the key
   `streampay_mru_wallet`. If the id matches a provider, that provider is
   moved to index 0; the rest keep their declared order.
4. The user clicks a provider.
5. `setMRUWalletId(id)` is called *before* the modal closes, so the next open
   already sees the updated value.

## Storage details

- **Key:** `streampay_mru_wallet`
- **Format:** A plain string id (e.g. `freighter`, `xbull`, `albedo`,
  `rabet`). Single value — *not* an ordered list — because the connect modal
  only needs to surface the last-used provider at the top.
- **Scope:** `localStorage` (per-origin, per-browser profile). Cleared by the
  browser if the user wipes site data; never user-controlled from the UI.
- **No network:** The MRU hint is purely a client-side UX optimization. It
  is never sent to the backend and never appears in any audit log.

## Public API

All helpers live in `app/state/walletPrefs.ts`:

```ts
import {
  defaultProviders, // WalletProvider[] — Freighter / xBull / Albedo / Rabet
  getMRUWalletId,   // () => string | null
  setMRUWalletId,   // (id: string) => void
  getSortedProviders, // (providers?) => WalletProvider[]
} from "../state/walletPrefs";
```

`WalletModal.tsx` is the only consumer today.

## Resilience

- **SSR safe.** `getMRUWalletId`, `setMRUWalletId`, and `getSortedProviders`
  all early-return when `typeof window === "undefined"`, so server renders
  never throw.
- **Storage failures.** Both reads and writes are wrapped in try/catch so a
  `QuotaExceededError` or a disabled `localStorage` (private mode in some
  browsers) silently degrades to "no preference", never breaking the connect
  flow.
- **Stale / unknown ids.** If `localStorage` holds an id that no longer maps
  to a known provider (e.g. the provider list changed), `getSortedProviders`
  returns the input order unchanged. The stale value is left alone — clearing
  it would risk surprising users who upgrade between releases.
- **No mutation of the input, always returns a fresh array.**
  `getSortedProviders` never mutates the array callers pass in and
  always returns a freshly-allocated array, so callers may freely
  splice / sort / pop the result without affecting future reads or
  `defaultProviders`. `defaultProviders` is also typed `readonly
  WalletProvider[]` for an extra compile-time guard.

## Why a single id (not a list)

The provider list is small (4 entries) and static. Tracking an ordered list
of recently-used ids would require JSON encoding, dedup, capping, and SSR
parsing — for no UX payoff because the modal only needs to lift the
last-used entry to the top. If the provider list ever grows large or starts
supporting user-defined entries, revisit this and migrate to an array similar
to [`app/state/recentRecipients.ts`](../app/state/recentRecipients.ts).

## Testing

- **Component tests:** [`app/components/WalletModal.test.tsx`](../app/components/WalletModal.test.tsx)
  — covers the user-visible ordering and that clicking a provider updates
  `localStorage`.
- **State module unit tests:** [`app/state/walletPrefs.test.ts`](../app/state/walletPrefs.test.ts)
  — covers the helpers in isolation: storage round-trips, custom input
  arrays, stale ids, idempotent calls, SSR safety, and immutability.
