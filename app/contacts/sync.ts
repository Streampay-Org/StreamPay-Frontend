/**
 * Pure contact merge logic for per-wallet address-book sync.
 *
 * Merge strategy: **last-write-wins per contact id**.
 *
 * - Each contact carries an `updatedAt` timestamp (ISO 8601).
 * - Deleted contacts carry a `deletedAt` tombstone; tombstoned contacts are
 *   excluded from the final list but kept so concurrent additions on another
 *   device don't resurrect them.
 * - If the same contact id exists on both sides, the one with the later
 *   `updatedAt` wins.
 * - If `updatedAt` is equal, the remote version wins (server is canonical).
 *
 * This module is pure — no network, no storage, no side effects — so it can
 * be unit-tested deterministically.
 */

export interface SyncedContact {
  id: string;
  label: string;
  address: string;
  federationAddress?: string;
  memo?: string;
  requiredMemo?: { type: "text" | "id" | "hash"; value: string };
  createdAt: string;
  /** ISO 8601 timestamp of the last update. */
  updatedAt: string;
  /** ISO 8601 timestamp when the contact was deleted (tombstone). */
  deletedAt?: string;
}

/**
 * Merge two contact lists into one, resolving conflicts by last-write-wins
 * per contact id.
 *
 * @param local  - Contacts from localStorage (the offline cache).
 * @param remote - Contacts from the server.
 * @returns Merged list of non-tombstoned contacts, sorted by createdAt.
 */
export function mergeContacts(
  local: SyncedContact[],
  remote: SyncedContact[],
): SyncedContact[] {
  const byId = new Map<string, SyncedContact>();

  // Insert all local contacts
  for (const c of local) {
    byId.set(c.id, c);
  }

  // Merge remote contacts — last-write-wins
  for (const remoteContact of remote) {
    const localContact = byId.get(remoteContact.id);
    if (!localContact) {
      // Remote has a contact local doesn't — add it
      byId.set(remoteContact.id, remoteContact);
      continue;
    }

    // Both sides have this contact — compare updatedAt
    const localUpdated = new Date(localContact.updatedAt).getTime();
    const remoteUpdated = new Date(remoteContact.updatedAt).getTime();

    if (Number.isNaN(localUpdated) && Number.isNaN(remoteUpdated)) {
      // Neither has a valid timestamp — prefer remote (server canonical)
      byId.set(remoteContact.id, remoteContact);
    } else if (remoteUpdated >= localUpdated) {
      // Remote is newer or equal — remote wins (server canonical)
      byId.set(remoteContact.id, remoteContact);
    }
    // Otherwise local is newer — keep local
  }

  // Filter out tombstoned contacts (deletedAt is set)
  const merged: SyncedContact[] = [];
  for (const c of byId.values()) {
    if (!c.deletedAt) {
      merged.push(c);
    }
  }

  // Sort by createdAt ascending
  merged.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return merged;
}

/**
 * Merge including tombstones — returns all contacts including deleted ones.
 * Used when pushing the merged list back to the server so tombstones persist.
 */
export function mergeContactsWithTombstones(
  local: SyncedContact[],
  remote: SyncedContact[],
): SyncedContact[] {
  const byId = new Map<string, SyncedContact>();

  for (const c of local) {
    byId.set(c.id, c);
  }

  for (const remoteContact of remote) {
    const localContact = byId.get(remoteContact.id);
    if (!localContact) {
      byId.set(remoteContact.id, remoteContact);
      continue;
    }

    const localUpdated = new Date(localContact.updatedAt).getTime();
    const remoteUpdated = new Date(remoteContact.updatedAt).getTime();

    if (Number.isNaN(localUpdated) && Number.isNaN(remoteUpdated)) {
      byId.set(remoteContact.id, remoteContact);
    } else if (remoteUpdated >= localUpdated) {
      byId.set(remoteContact.id, remoteContact);
    }
  }

  const merged: SyncedContact[] = [];
  for (const c of byId.values()) {
    merged.push(c);
  }

  merged.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return merged;
}
