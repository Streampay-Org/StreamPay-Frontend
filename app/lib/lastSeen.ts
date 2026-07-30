import { getStore } from "./db";

/**
 * Updates the last_seen timestamp for a user to the current time.
 * @param walletAddress - The wallet address of the user to update.
 */
export function updateLastSeen(walletAddress: string): void {
  const store = getStore();
  const existingUser = store.streamRepository.users.get(walletAddress);
  const now = new Date().toISOString();

  if (existingUser) {
    // Update existing user's last_seen
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
