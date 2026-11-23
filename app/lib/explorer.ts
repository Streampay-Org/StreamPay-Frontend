/**
 * Stellar Explorer URL helpers
 *
 * Builds links to the network-appropriate Stellar explorer for transactions
 * and accounts, using the per-network `explorerUrl` defined in the Stellar
 * network profiles.
 *
 * Both helpers return `null` for unknown networks (e.g. 'future') and for
 * inputs that fail validation, so callers can safely fall back to plain text.
 */

import { getNetworkProfile, StellarNetwork } from './config/stellar';

/** Matches a 64-character lowercase or uppercase hexadecimal string. */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Returns the explorer URL for a Stellar transaction, or `null` when:
 * - `network` has no registered profile (e.g. 'future')
 * - `txHash` is not a 64-character hex string (after trimming whitespace)
 *
 * The hash is normalised to lowercase before being embedded in the URL.
 */
export function explorerTxUrl(
  network: StellarNetwork,
  txHash: string,
): string | null {
  const trimmed = txHash.trim();
  if (!TX_HASH_RE.test(trimmed)) {
    return null;
  }

  let profile;
  try {
    profile = getNetworkProfile(network);
  } catch {
    return null;
  }

  return `${profile.explorerUrl}/tx/${encodeURIComponent(trimmed.toLowerCase())}`;
}

/**
 * Returns the explorer URL for a Stellar account address, or `null` when:
 * - `network` has no registered profile (e.g. 'future')
 * - `address` is an empty string after trimming
 */
export function explorerAccountUrl(
  network: StellarNetwork,
  address: string,
): string | null {
  const trimmed = address.trim();
  if (!trimmed) {
    return null;
  }

  let profile;
  try {
    profile = getNetworkProfile(network);
  } catch {
    return null;
  }

  return `${profile.explorerUrl}/account/${encodeURIComponent(trimmed)}`;
}
