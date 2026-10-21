/**
 * onboardingProgress.ts
 *
 * Derives checklist progress from client-side storage.
 * Safe in private mode or when storage throws.
 */

export interface StorageReader {
  getItem: (key: string) => string | null;
}

export type ChecklistItemStatus = "not_started" | "in_progress" | "completed";

export interface OnboardingChecklistItem {
  id: string;
  title: string;
  status: ChecklistItemStatus;
  statusText: string;
  explanation: string;
  href: string;
  linkText: string;
}

export interface OnboardingProgress {
  items: OnboardingChecklistItem[];
  completed: number;
  total: number;
}

// Storage keys
export const STORAGE_KEYS = {
  WALLET_MRU: "streampay_mru_wallet",
  WALLET_SESSION: "streampay_wallet_session",
  CONTACTS: "streampay_contacts",
  TEMPLATES_VISITED: "streampay_templates_visited",
  WIZARD_DRAFT: "streampay.wizard-draft",
  STREAM_CREATED: "streampay_stream_created",
  RECENT_RECIPIENTS: "streampay_recent_recipients",
  HIDE_CHECKLIST: "streampay_hide_onboarding_checklist",
} as const;

/**
 * Safe wrapper for reading from storage (localStorage or injected storage-like object).
 * Returns null if storage is unavailable or throws.
 */
export function safeGetItem(storage: StorageReader | null | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Determines whether a wallet is connected.
 * Checks wallet preferences (MRU) or session storage / state.
 */
function isWalletConnected(storage: StorageReader | null | undefined): boolean {
  const mru = safeGetItem(storage, STORAGE_KEYS.WALLET_MRU);
  if (mru && mru.trim()) return true;

  const session = safeGetItem(storage, STORAGE_KEYS.WALLET_SESSION);
  if (session && session.trim()) return true;

  return false;
}

/**
 * Determines whether at least one contact is saved.
 * Returns true if contacts in streampay_contacts is a non-empty array.
 */
function isContactSaved(storage: StorageReader | null | undefined): boolean {
  const raw = safeGetItem(storage, STORAGE_KEYS.CONTACTS);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Determines whether templates have been browsed / visited.
 */
function isTemplatesVisited(storage: StorageReader | null | undefined): boolean {
  const visited = safeGetItem(storage, STORAGE_KEYS.TEMPLATES_VISITED);
  return visited === "true" || visited === "1";
}

/**
 * Determines stream creation / draft status.
 * Returns:
 * - "completed" if stream created flag is set or recent recipients exist
 * - "in_progress" if wizard draft is present
 * - "not_started" otherwise
 */
function getStreamStatus(storage: StorageReader | null | undefined): ChecklistItemStatus {
  // Check if a stream was created
  const streamCreated = safeGetItem(storage, STORAGE_KEYS.STREAM_CREATED);
  if (streamCreated === "true" || streamCreated === "1") {
    return "completed";
  }

  const rawRecipients = safeGetItem(storage, STORAGE_KEYS.RECENT_RECIPIENTS);
  if (rawRecipients) {
    try {
      const parsed = JSON.parse(rawRecipients);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return "completed";
      }
    } catch {
      // ignore
    }
  }

  // Check if a draft exists
  const rawDraft = safeGetItem(storage, STORAGE_KEYS.WIZARD_DRAFT);
  if (rawDraft) {
    try {
      const draft = JSON.parse(rawDraft);
      if (draft && typeof draft === "object") {
        return "in_progress";
      }
    } catch {
      // ignore
    }
  }

  return "not_started";
}

/**
 * Pure function to derive onboarding progress from a storage object.
 * Safe in private mode or when storage throws.
 */
export function getOnboardingProgress(
  storage?: StorageReader | null
): OnboardingProgress {
  const walletDone = isWalletConnected(storage);
  const contactDone = isContactSaved(storage);
  const templatesDone = isTemplatesVisited(storage);
  const streamStatus = getStreamStatus(storage);
  const streamDone = streamStatus === "completed";

  const items: OnboardingChecklistItem[] = [
    {
      id: "connect-wallet",
      title: "Connect a wallet",
      status: walletDone ? "completed" : "not_started",
      statusText: walletDone ? "Completed" : "To do",
      explanation: "Connect your Stellar wallet to send and manage payments.",
      href: "/settings",
      linkText: "Connect wallet",
    },
    {
      id: "save-contact",
      title: "Save a contact",
      status: contactDone ? "completed" : "not_started",
      statusText: contactDone ? "Completed" : "To do",
      explanation: "Add a recipient address to your address book for quick reuse.",
      href: "/contacts",
      linkText: "Open contacts",
    },
    {
      id: "browse-templates",
      title: "Browse templates",
      status: templatesDone ? "completed" : "not_started",
      statusText: templatesDone ? "Completed" : "To do",
      explanation: "Explore pre-configured stream templates for payroll and recurring payouts.",
      href: "/templates",
      linkText: "View templates",
    },
    {
      id: "create-stream",
      title: "Create a first stream",
      status: streamStatus,
      statusText:
        streamStatus === "completed"
          ? "Completed"
          : streamStatus === "in_progress"
          ? "In progress"
          : "To do",
      explanation: "Start a real-time money stream to any Stellar address.",
      href: "/streams/new",
      linkText: streamStatus === "in_progress" ? "Resume stream" : "Create stream",
    },
  ];

  let completed = 0;
  if (walletDone) completed += 1;
  if (contactDone) completed += 1;
  if (templatesDone) completed += 1;
  if (streamDone) completed += 1;

  return {
    items,
    completed,
    total: items.length,
  };
}

/**
 * Check whether checklist is hidden.
 */
export function isChecklistHidden(storage?: StorageReader | null): boolean {
  const hidden = safeGetItem(storage, STORAGE_KEYS.HIDE_CHECKLIST);
  return hidden === "true" || hidden === "1";
}

/**
 * Persist hide checklist preference.
 */
export function setChecklistHidden(storage?: StorageReader | null, hide = true): void {
  if (!storage) return;
  try {
    (storage as Storage).setItem(
      STORAGE_KEYS.HIDE_CHECKLIST,
      hide ? "true" : "false"
    );
  } catch {
    // Fail silently in private mode
  }
}
