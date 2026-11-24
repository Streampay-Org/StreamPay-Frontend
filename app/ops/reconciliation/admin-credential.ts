/**
 * Admin credential handling for the operations dashboard.
 *
 * The dashboard talks to the admin-gated diff proxy. Operators paste either a
 * short-lived admin JWT or their admin wallet address; the credential lives in
 * `sessionStorage` only (per-tab, cleared when the tab closes) and is never
 * persisted server-side.
 */

export const ADMIN_CREDENTIAL_STORAGE_KEY = "streampay-ops-admin-credential";

/** Fired on `window` when the stored credential changes, so nav can react. */
export const ADMIN_CREDENTIAL_CHANGED_EVENT = "streampay:admin-credential-changed";

/** Stellar account addresses are `G` followed by 55 base32 characters. */
const WALLET_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export function readAdminCredential(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(ADMIN_CREDENTIAL_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeAdminCredential(value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.sessionStorage.setItem(ADMIN_CREDENTIAL_STORAGE_KEY, value);
    } else {
      window.sessionStorage.removeItem(ADMIN_CREDENTIAL_STORAGE_KEY);
    }
  } catch {
    // sessionStorage unavailable (private mode, quota) — the page still works
    // for the current render, it just cannot remember the credential.
  }
  try {
    window.dispatchEvent(new Event(ADMIN_CREDENTIAL_CHANGED_EVENT));
  } catch {
    // Event dispatch is best-effort (e.g. non-browser test doubles).
  }
}

/**
 * Map a pasted credential to request headers.
 * Wallet addresses use `Actor-Wallet-Address`; anything else is treated as a
 * bearer JWT.
 */
export function buildAdminAuthHeaders(credential: string): Record<string, string> {
  const value = credential.trim();
  if (!value) return {};
  if (WALLET_ADDRESS_RE.test(value)) {
    return { "Actor-Wallet-Address": value };
  }
  return { Authorization: `Bearer ${value}` };
}
