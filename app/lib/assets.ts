/**
 * Asset Engine for StreamPay
 * Handles XLM and Stellar custom assets (Trustlines).
 */

import { getConfig } from './config';

export interface StellarAsset {
  code: string;
  issuer?: string;
  isNative: boolean;
}

export const NATIVE_ASSET: StellarAsset = {
  code: 'XLM',
  isNative: true,
};

/**
 * Parses an asset string (e.g. "USDC:GABC...") or returns native.
 */
export function parseAssetString(assetStr: string): StellarAsset {
  if (!assetStr || assetStr.toUpperCase() === 'XLM' || assetStr.toLowerCase() === 'native') {
    return NATIVE_ASSET;
  }

  if (assetStr.includes(':')) {
    const parts = assetStr.split(':');
    const [code, issuer] = parts;
    if (
      parts.length === 2 &&
      /^[A-Za-z0-9]{1,12}$/.test(code) &&
      issuer.length === 56 &&
      issuer.startsWith('G')
    ) {
      return { code: code.toUpperCase(), issuer, isNative: false };
    }
  }

  throw new Error(`Invalid asset format: ${assetStr}. Expected XLM or CODE:ISSUER`);
}

export const VERIFY_TRUSTLINE_TIMEOUT_MS = 5000;

interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/**
 * Fetches account balances from Horizon and checks for a specific trustline.
 * Horizon URL is now sourced from centralized config to prevent hardcoded URLs.
 */
export async function verifyTrustline(
  publicKey: string,
  asset: StellarAsset,
  horizonUrl?: string,
  timeoutMs: number = VERIFY_TRUSTLINE_TIMEOUT_MS
): Promise<{ exists: boolean; error?: string }> {
  if (asset.isNative) return { exists: true };

  // Use provided horizonUrl or fall back to config
  const config = getConfig();
  const effectiveHorizonUrl = horizonUrl || config.network.horizonUrl;

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const encodedPublicKey = encodeURIComponent(publicKey);
    const response = await fetch(
      `${effectiveHorizonUrl}/accounts/${encodedPublicKey}`,
      { signal: controller.signal }
    );

    if (response.status === 404) {
      return { exists: false, error: 'Recipient account does not exist on-chain.' };
    }

    if (!response.ok) {
      return { exists: false, error: `Horizon error: ${response.status}` };
    }

    const data = await response.json();
    const balances: unknown[] = Array.isArray(data?.balances) ? data.balances : [];
    const hasTrustline = balances.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const b = entry as HorizonBalance;
      if (b.asset_type === 'liquidity_pool_shares' || !b.asset_code) {
        return false;
      }
      return b.asset_code === asset.code && b.asset_issuer === asset.issuer;
    });

    if (!hasTrustline) {
      return { exists: false, error: `Missing trustline for ${asset.code}.` };
    }

    return { exists: true };
  } catch (err: unknown) {
    if (timedOut) {
      return {
        exists: false,
        error: `Horizon request timed out after ${timeoutMs}ms.`,
      };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { exists: false, error: 'Horizon request was aborted.' };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { exists: false, error: `Network error: ${message}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validates if an asset can be used for a stream.
 */
export function validateAssetPair(sourceAsset: StellarAsset, destAsset: StellarAsset): boolean {
  // v1 limitation: source and destination must match unless a path payment is used
  // For now, we enforce same asset
  return (
    sourceAsset.isNative === destAsset.isNative &&
    sourceAsset.code === destAsset.code &&
    sourceAsset.issuer === destAsset.issuer
  );
}
