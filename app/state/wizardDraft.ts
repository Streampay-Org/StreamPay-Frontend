/**
 * wizardDraft.ts
 *
 * Thin localStorage adapter for the "Save draft" feature (#863).
 *
 * Persists the CreateStream single-recipient wizard form state so the user
 * can close or navigate away and return to a partially-filled form without
 * losing work.
 *
 * ### Storage contract
 * Key:    `streampay.wizard-draft`
 * Value:  JSON-encoded `WizardDraft` object
 *
 * ### Security / privacy notes
 * - Stellar addresses (public keys) are not sensitive — they are designed to
 *   be shared.  Amounts and token type are also non-sensitive configuration.
 * - The draft is written to the same origin's localStorage, so it is never
 *   transmitted over the network and is isolated per-origin.
 * - `clearWizardDraft()` is called on successful stream creation so stale
 *   data is not retained after the workflow completes.
 *
 * ### SSR safety
 * All exported functions guard against `window === undefined` so Next.js
 * server-side rendering does not throw.
 */

import { safeStorage } from "../lib/safeStorage";

export interface WizardDraft {
  /** Stellar address (or partial input) of the intended recipient. */
  recipient: string;
  /** Raw amount string, exactly as typed by the user (preserves decimal precision). */
  amount: string;
  /** Selected token. */
  token: "XLM" | "USDC";
  /** Whether the recipient bears the Stellar network fee. */
  gasOnRecipient: boolean;
  /**
   * Unix timestamp (ms) when the draft was last written.
   * Used for display ("Saved N minutes ago") and future TTL expiry logic.
   */
  savedAt: number;
}

/** localStorage key — kept in one place to avoid typo drift. */
export const WIZARD_DRAFT_KEY = "streampay.wizard-draft";

/**
 * Returns `true` when all draft fields are at their pristine/default values.
 */
export function isWizardDraftEmpty(
  draft: Omit<WizardDraft, "savedAt">,
): boolean {
  return (
    draft.recipient.trim() === "" &&
    draft.amount.trim() === "" &&
    draft.token === "XLM" &&
    draft.gasOnRecipient === false
  );
}

/**
 * Returns the persisted draft, or `null` when:
 *  - no draft has been saved yet
 *  - the stored JSON is malformed
 *  - required fields are missing / wrong type (schema guard)
 *  - the code is running server-side
 */
export function getWizardDraft(): WizardDraft | null {
  try {
    const raw = safeStorage.getItem(WIZARD_DRAFT_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);

    // Minimal schema guard — ensure the shape matches before trusting it
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).recipient !== "string" ||
      typeof (parsed as Record<string, unknown>).amount !== "string" ||
      typeof (parsed as Record<string, unknown>).gasOnRecipient !== "boolean" ||
      typeof (parsed as Record<string, unknown>).savedAt !== "number"
    ) {
      return null;
    }

    const candidate = parsed as WizardDraft;

    // Whitelist token values
    if (candidate.token !== "XLM" && candidate.token !== "USDC") return null;

    return candidate;
  } catch {
    // JSON.parse failure — corrupted entry; ignore
    return null;
  }
}

/**
 * Persists the current wizard state.  Call this on every field change so
 * the draft is always up-to-date even if the user closes the tab abruptly.
 * Pristine/empty drafts are never persisted.
 */
export function saveWizardDraft(
  draft: Omit<WizardDraft, "savedAt">,
): void {
  if (isWizardDraftEmpty(draft)) return;

  try {
    const payload: WizardDraft = { ...draft, savedAt: Date.now() };
    safeStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    // localStorage full or unavailable — fail silently
  }
}

/**
 * Removes the persisted draft.  Call this after a successful stream creation
 * or when the user discards the draft so stale data is not re-loaded on the
 * next visit.
 */
export function clearWizardDraft(): void {
  try {
    safeStorage.removeItem(WIZARD_DRAFT_KEY);
  } catch {
    // ignore
  }
}
