import type { ActivityEvent } from "@/app/types/openapi";

function encodeCompositeCursor(timestamp: string, id: string): string {
  const payload = `${timestamp}|${id}`;
  return Buffer.from(payload).toString("base64");
}

function decodeCompositeCursor(cursor: string): { timestamp: string; id: string } {
  if (!cursor || typeof cursor !== "string") {
    throw new Error("Invalid cursor: must be non-empty string");
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    throw new Error("Invalid cursor: malformed base64");
  }
  const separatorIndex = decoded.indexOf("|");
  if (separatorIndex === -1) {
    throw new Error("Invalid cursor: malformed composite key");
  }
  const timestamp = decoded.slice(0, separatorIndex);
  const id = decoded.slice(separatorIndex + 1);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Invalid cursor: timestamp segment is not a valid ISO-8601 string");
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new Error("Invalid cursor: id segment contains disallowed characters");
  }
  return {
    timestamp,
    id,
  };
}

export interface ActivityTimelineEntry {
  id: string;
  type: string;
  streamId?: string;
  /**
   * Wallet that produced a non-stream event (for example `wallet.connected`).
   * Stream events derive their owner from the associated stream record.
   */
  actorAddress?: string;
  timestamp: string;
  description: string;
  projectedAt: string;
}

export interface ActivityTimelineQuery {
  cursor?: string;
  limit: number;
  streamId?: string;
  type?: string;
  /**
   * Additional request-scoped filter. Applied before `total`, cursor slicing
   * and `hasNext` are computed so pagination metadata reflects the visible
   * (scoped) set only.
   */
  predicate?: (entry: ActivityTimelineEntry) => boolean;
}

export interface ActivityTimelineQueryResult {
  data: ActivityTimelineEntry[];
  meta: {
    hasNext: boolean;
    nextCursor: string | null;
    total: number;
  };
}

export interface ActivityTimelineStore {
  readonly length: number;
  append(entry: ActivityTimelineEntry): void;
  query(params: ActivityTimelineQuery): ActivityTimelineQueryResult;
  getLagMs(): number;
  backfill(entries: ActivityTimelineEntry[]): void;
  getLatestProjectedTimestamp(): string | null;
  reset(): void;
}

class InMemoryActivityTimelineStore implements ActivityTimelineStore {
  private entries: ActivityTimelineEntry[] = [];

  get length(): number {
    return this.entries.length;
  }

  append(entry: ActivityTimelineEntry): void {
    const insertAt = this.findInsertIndex(entry);
    this.entries.splice(insertAt, 0, entry);
  }

  query(params: ActivityTimelineQuery): ActivityTimelineQueryResult {
    const { cursor, limit, streamId, type, predicate } = params;
    let filtered = this.entries;

    if (streamId) {
      filtered = filtered.filter((e) => e.streamId === streamId);
    }
    if (type) {
      filtered = filtered.filter((e) => e.type === type);
    }
    if (predicate) {
      filtered = filtered.filter(predicate);
    }

    const totalFiltered = filtered.length;

    if (cursor) {
      let cursorTimestamp: string;
      let cursorId: string;
      try {
        const decoded = decodeCompositeCursor(cursor);
        cursorTimestamp = decoded.timestamp;
        cursorId = decoded.id;
      } catch {
        return { data: [], meta: { hasNext: false, nextCursor: null, total: totalFiltered } };
      }
      filtered = filtered.filter((event) => {
        const tsCmp = event.timestamp.localeCompare(cursorTimestamp);
        return tsCmp < 0 || (tsCmp === 0 && event.id.localeCompare(cursorId) < 0);
      });
    }

    const paginated = filtered.slice(0, limit);
    const hasNext = filtered.length > limit;
    const nextCursor =
      hasNext && paginated.length > 0
        ? encodeCompositeCursor(paginated[paginated.length - 1].timestamp, paginated[paginated.length - 1].id)
        : null;

    return {
      data: paginated,
      meta: { hasNext, nextCursor, total: totalFiltered },
    };
  }

  getLagMs(): number {
    if (this.entries.length === 0) return 0;
    const latest = this.entries[0];
    return Date.now() - new Date(latest.timestamp).getTime();
  }

  backfill(entries: ActivityTimelineEntry[]): void {
    const sorted = [...entries].sort((a, b) => {
      const tsCmp = b.timestamp.localeCompare(a.timestamp);
      return tsCmp !== 0 ? tsCmp : b.id.localeCompare(a.id);
    });
    this.entries = sorted;
  }

  getLatestProjectedTimestamp(): string | null {
    if (this.entries.length === 0) return null;
    return this.entries[0].timestamp;
  }

  reset(): void {
    this.entries = [];
  }

  private findInsertIndex(entry: ActivityTimelineEntry): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const existing = this.entries[mid];
      const tsCmp = existing.timestamp.localeCompare(entry.timestamp);
      if (tsCmp < 0 || (tsCmp === 0 && existing.id.localeCompare(entry.id) < 0)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    return low;
  }
}

export function createActivityTimelineStore(): ActivityTimelineStore {
  return new InMemoryActivityTimelineStore();
}

export function mergeActivityTimelinePages(
  pages: ActivityTimelineEntry[][],
): ActivityTimelineEntry[] {
  const byId = new Map<string, ActivityTimelineEntry>();

  for (const page of pages) {
    for (const entry of page) {
      const existing = byId.get(entry.id);
      if (!existing || entry.timestamp.localeCompare(existing.timestamp) > 0) {
        byId.set(entry.id, entry);
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    const tsCmp = b.timestamp.localeCompare(a.timestamp);
    return tsCmp !== 0 ? tsCmp : b.id.localeCompare(a.id);
  });
}

export function activityEventToTimelineEntry(
  event: ActivityEvent,
  projectedAt?: string,
): ActivityTimelineEntry {
  return {
    id: event.id,
    type: event.type,
    streamId: event.streamId,
    actorAddress: event.actorAddress,
    timestamp: event.timestamp,
    description: event.description,
    projectedAt: projectedAt ?? new Date().toISOString(),
  };
}
