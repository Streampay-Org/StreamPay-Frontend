import { isValidStellarPublicKey } from "../lib/stellar-address";

const RECENT_RECIPIENTS_KEY = "streampay_recent_recipients";
const MAX_RECENT = 6;

export interface RecentRecipient {
  address: string;
  addedAt: number;
}

function isValidRecentRecipient(entry: unknown): entry is RecentRecipient {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.address === "string" &&
    isValidStellarPublicKey(candidate.address) &&
    typeof candidate.addedAt === "number" &&
    Number.isFinite(candidate.addedAt)
  );
}

export function getRecentRecipients(): RecentRecipient[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_RECIPIENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidRecentRecipient)
      .map(({ address, addedAt }) => ({ address, addedAt }));
  } catch {
    return [];
  }
}

/**
 * Prepends `address` to the recent-recipients list, deduplicating and capping
 * at MAX_RECENT entries. No-ops for empty or invalid Stellar public keys.
 */
export function addRecentRecipient(address: string): void {
  if (typeof window === "undefined") return;
  const trimmed = address.trim();
  if (!trimmed || !isValidStellarPublicKey(trimmed)) return;

  const deduped = getRecentRecipients().filter((r) => r.address !== trimmed);
  const updated: RecentRecipient[] = [
    { address: trimmed, addedAt: Date.now() },
    ...deduped,
  ].slice(0, MAX_RECENT);

  try {
    localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures (e.g. private browsing or quota exceeded).
  }
}

export function clearRecentRecipients(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RECENT_RECIPIENTS_KEY);
  } catch {
    // Ignore storage failures.
  }
}
