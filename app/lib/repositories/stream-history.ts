/**
 * Append-only per-stream lifecycle event store.
 *
 * Entries record every committed lifecycle change (created, started, paused,
 * resumed, stopped, settled, withdrawn, cancelled). Entries are never mutated.
 * Ordering is commit-time descending (newest-first on query).
 *
 * Pagination uses a composite (at, id) cursor identical to the pattern used by
 * `activity-timeline.ts` so callers share the same mental model.
 *
 * No PII — no email, label, memo, or full wallet address in entries.
 * Actor wallets are truncated to the first 6 chars for attribution.
 */

export type StreamHistoryEventType =
  | "created"
  | "started"
  | "paused"
  | "resumed"
  | "stopped"
  | "withdrawn"
  | "settled"
  | "cancelled";

/** A single immutable lifecycle event entry. */
export interface StreamHistoryEntry {
  readonly id: string;
  readonly streamId: string;
  readonly type: StreamHistoryEventType;
  /** Status before this transition (absent for "created"). */
  readonly fromStatus?: string;
  /** Status after this transition. */
  readonly toStatus: string;
  /** ISO-8601 UTC timestamp of this committed change. */
  readonly at: string;
  /**
   * First 6 characters of the actor's wallet address (no PII).
   * Absent when the actor is unknown or system-initiated.
   */
  readonly actor?: string;
  /** Optional on-chain tx hash (populated once indexer is wired). */
  readonly txHash?: string;
  /** Optional human-readable amount label, e.g. "120 XLM". */
  readonly amountRaw?: string;
}

export interface StreamHistoryQuery {
  streamId: string;
  cursor?: string;
  limit: number;
}

export interface StreamHistoryQueryResult {
  data: StreamHistoryEntry[];
  meta: { nextCursor: string | null };
}

export interface StreamHistoryStore {
  append(entry: StreamHistoryEntry): void;
  query(params: StreamHistoryQuery): StreamHistoryQueryResult;
  reset(): void;
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString("base64");
}

function decodeCursor(cursor: string): { at: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    throw new Error("Invalid cursor: malformed base64");
  }
  const sep = decoded.indexOf("|");
  if (sep === -1) throw new Error("Invalid cursor: missing separator");
  const at = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(Date.parse(at))) {
    throw new Error("Invalid cursor: at is not ISO-8601");
  }
  return { at, id };
}

// ── Store implementation ──────────────────────────────────────────────────────

class InMemoryStreamHistoryStore implements StreamHistoryStore {
  /** Per-stream arrays in insertion (ascending-time) order. */
  private readonly byStream = new Map<string, StreamHistoryEntry[]>();

  append(entry: StreamHistoryEntry): void {
    let list = this.byStream.get(entry.streamId);
    if (!list) {
      list = [];
      this.byStream.set(entry.streamId, list);
    }
    // Idempotency: skip if an entry with this id already exists.
    if (list.some((e) => e.id === entry.id)) return;
    list.push(entry);
  }

  query({ streamId, cursor, limit }: StreamHistoryQuery): StreamHistoryQueryResult {
    const list = this.byStream.get(streamId) ?? [];

    // Sort newest-first: (at desc, id desc) for stable deterministic ordering.
    const descending = [...list].sort((a, b) => {
      const cmp = b.at.localeCompare(a.at);
      return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
    });

    let items = descending;

    if (cursor) {
      let cursorAt: string;
      let cursorId: string;
      try {
        ({ at: cursorAt, id: cursorId } = decodeCursor(cursor));
      } catch {
        return { data: [], meta: { nextCursor: null } };
      }
      // Keep entries strictly older than (or same timestamp, lexically before) the cursor.
      items = descending.filter((e) => {
        const cmp = e.at.localeCompare(cursorAt);
        return cmp < 0 || (cmp === 0 && e.id.localeCompare(cursorId) < 0);
      });
    }

    const page = items.slice(0, limit);
    const hasNext = items.length > limit;
    const nextCursor =
      hasNext && page.length > 0
        ? encodeCursor(page[page.length - 1].at, page[page.length - 1].id)
        : null;

    return { data: page, meta: { nextCursor } };
  }

  reset(): void {
    this.byStream.clear();
  }
}

export function createStreamHistoryStore(): StreamHistoryStore {
  return new InMemoryStreamHistoryStore();
}

/**
 * Truncate a wallet address to its first 6 characters.
 * Returns undefined for falsy inputs so callers can omit the field cleanly.
 */
export function truncateActor(wallet: string | null | undefined): string | undefined {
  if (!wallet) return undefined;
  return wallet.slice(0, 6);
}
