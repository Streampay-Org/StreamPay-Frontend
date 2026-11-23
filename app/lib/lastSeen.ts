import { getStore } from "./db";

/**
 * Decide whether a `candidate` ISO-8601 timestamp may replace `existing` while
 * preserving the monotonic "last_seen" invariant.
 *
 * The stored value must never move *backward*: a stale request generated before
 * a newer one must not overwrite the newer timestamp.  We only advance when the
 * candidate is strictly later than the stored value.  Unparseable values never
 * clobber a known-good stored timestamp.
 *
 * @param candidate  The incoming timestamp.
 * @param existing   The currently stored timestamp, or `undefined` if absent.
 */
function isMonotonicAdvance(
  candidate: string,
  existing: string | undefined,
): boolean {
  if (existing === undefined) return true;
  const candidateMs = Date.parse(candidate);
  const existingMs = Date.parse(existing);
  if (Number.isNaN(candidateMs) || Number.isNaN(existingMs)) return false;
  return candidateMs > existingMs;
}

/**
 * Updates the last_seen timestamp for a user, but only when the new value is
 * strictly later than the existing one.  This prevents a stale or out-of-order
 * write (e.g. a retried or delayed request) from moving the user's last-seen
 * marker backward, which would otherwise corrupt "active user" analytics.
 *
 * @param walletAddress - The wallet address of the user to update.
 */
export function updateLastSeen(walletAddress: string): void {
  const store = getStore();
  const existingUser = store.streamRepository.users.get(walletAddress);
  const now = new Date().toISOString();

  if (existingUser) {
    // Only advance last_seen when the new timestamp is strictly later.
    if (!isMonotonicAdvance(now, existingUser.last_seen ?? undefined)) return;
    store.streamRepository.users.set(walletAddress, {
      ...existingUser,
      last_seen: now,
    });
  } else {
    // Create a minimal user record if one doesn't exist yet
    store.streamRepository.users.set(walletAddress, {
      wallet_address: walletAddress,
      email: null,
      display_name: "",
      avatar_url: null,
      created_at: now,
      last_seen: now,
    });
  }
}
