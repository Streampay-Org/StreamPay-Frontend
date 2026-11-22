const RECENT_RECIPIENTS_KEY = "streampay_recent_recipients";
const MAX_RECENT = 6;

export interface RecentRecipient {
  address: string;
  addedAt: number;
}

// Demo addresses (the seeded sample streams) offered on a first visit so the
// quick-pick rail is not empty. Skipped under Jest to keep tests deterministic.
const DEMO_RECENT_RECIPIENTS: RecentRecipient[] = [
  { address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7GQ", addedAt: 0 },
  { address: "GBVZZ5QKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQKXB4T2YXQXDXQ2ZQK", addedAt: 0 },
  { address: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDEAVQBMJ7WGNB55IAAQ", addedAt: 0 },
];

export function getRecentRecipients(): RecentRecipient[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_RECIPIENTS_KEY);
    if (raw === null && process.env.NODE_ENV !== "test") return DEMO_RECENT_RECIPIENTS;
    return raw ? (JSON.parse(raw) as RecentRecipient[]) : [];
  } catch {
    return [];
  }
}

/**
 * Prepends `address` to the recent-recipients list, deduplicating and capping
 * at MAX_RECENT entries. No-ops for empty/whitespace-only addresses.
 */
export function addRecentRecipient(address: string): void {
  if (typeof window === "undefined") return;
  const trimmed = address.trim();
  if (!trimmed) return;

  const deduped = getRecentRecipients().filter((r) => r.address !== trimmed);
  const updated: RecentRecipient[] = [
    { address: trimmed, addedAt: Date.now() },
    ...deduped,
  ].slice(0, MAX_RECENT);

  localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(updated));
}

export function clearRecentRecipients(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(RECENT_RECIPIENTS_KEY);
}
