
import { getNetworkProfile, type StellarNetwork } from "./config/stellar";
import { isValidStellarPublicKey } from "./stellar-address";

/**
 * Get the Stellar Expert explorer base URL for a supported network.
 *
 * The application's network configuration stores the explorer URL as a base
 * URL, while Stellar Expert expects network-specific paths:
 * - Mainnet: /explorer/public
 * - Testnet: /explorer/testnet
 *
 * Returns null when the network is unsupported or its explorer URL is invalid.
 */
function getExplorerBaseUrl(network: StellarNetwork): string | null {
  try {
    const profile = getNetworkProfile(network);

    const networkPath =
      profile.name === "mainnet"
        ? "public"
        : profile.name === "testnet"
          ? "testnet"
          : null;

    if (!networkPath) {
      return null;
    }

    // Use only the configured origin to avoid duplicating network path segments.
    const origin = new URL(profile.explorerUrl).origin;

    return `${origin}/explorer/${networkPath}`;
  } catch {
    // Unsupported networks or invalid URLs must not break the UI.
    return null;
  }
}

/**
 * Build a Stellar Expert account URL for a public key.
 *
 * Only valid Stellar ed25519 public keys (G... StrKeys) are supported.
 * Muxed accounts and arbitrary display strings are intentionally excluded.
 *
 * @param address - Stellar public account address.
 * @param network - Stellar network where the account should be inspected.
 * @returns The explorer URL, or null when the address or network is invalid.
 */
export function explorerAccountUrl(
  address: string,
  network: StellarNetwork,
): string | null {
  if (!isValidStellarPublicKey(address)) {
    return null;
  }

  const baseUrl = getExplorerBaseUrl(network);

  return baseUrl ? `${baseUrl}/account/${address}` : null;
}

/**
 * Build a Stellar Expert transaction URL for a transaction hash.
 *
 * Stellar transaction hashes are represented as 64 hexadecimal characters.
 * This checks the hash format only; it does not verify that the transaction
 * exists on the selected network.
 *
 * @param hash - Stellar transaction hash.
 * @param network - Stellar network where the transaction should be inspected.
 * @returns The explorer URL, or null when the hash or network is invalid.
 */
export function explorerTxUrl(
  hash: string,
  network: StellarNetwork,
): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
    return null;
  }

  const baseUrl = getExplorerBaseUrl(network);

  return baseUrl ? `${baseUrl}/tx/${hash}` : null;
}
