const MRU_WALLET_KEY = "streampay_mru_wallet";

export interface WalletProvider {
  id: string;
  name: string;
  icon?: string;
}

export const defaultProviders: readonly WalletProvider[] = [
  { id: "freighter", name: "Freighter" },
  { id: "xbull", name: "xBull" },
  { id: "albedo", name: "Albedo" },
  { id: "rabet", name: "Rabet" }
];

/**
 * Returns the most recently used (MRU) wallet id stored in `localStorage`,
 * or `null` when no usable preference has been recorded (no value stored,
 * empty string, or `window` unavailable). SSR-safe: simply returns `null`
 * when `window` is undefined.
 */
export function getMRUWalletId(): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(MRU_WALLET_KEY);
  return stored ? stored : null;
}

/**
 * Persist `id` as the most recently used wallet. Subsequent openings of
 * `<WalletModal />` will surface this provider first. SSR-safe (no-op when
 * `window` is unavailable).
 */
export function setMRUWalletId(id: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(MRU_WALLET_KEY, id);
}

/**
 * Returns the providers ordered such that the most recently used (MRU)
 * one appears first. A fresh array is always returned; the supplied
 * `providers` is never mutated.
 *
 * Behavior by case:
 *   1. No MRU preference stored → returns a copy of `providers` in
 *      their declared order.
 *   2. MRU id is known but already at index 0, OR the id is stale
 *      (no longer in the list) → returns a copy of `providers` in
 *      their declared order (no reorder needed).
 *   3. MRU id is present somewhere other than index 0 → returns a
 *      fresh array with that provider promoted to the head.
 *
 * `providers` is typed `readonly WalletProvider[]` because the function
 * only reads / spreads; callers may safely pass `defaultProviders` (also
 * `readonly`) or any locally-built list.
 *
 * Defaults to {@link defaultProviders} (Freighter, xBull, Albedo, Rabet).
 * SSR-safe: case (1) handles a missing `window` without throwing.
 */
export function getSortedProviders(
  providers: readonly WalletProvider[] = defaultProviders,
): readonly WalletProvider[] {
  const mruId = getMRUWalletId();
  if (!mruId) return [...providers];

  const mruIndex = providers.findIndex(p => p.id === mruId);

  // Already at the head, or stale id (not present in the list).
  // Both are no-ops as far as ordering goes; no allocation needed.
  if (mruIndex <= 0) return [...providers];

  const sorted = [...providers];
  const [mruProvider] = sorted.splice(mruIndex, 1);
  sorted.unshift(mruProvider);
  return sorted;
}
