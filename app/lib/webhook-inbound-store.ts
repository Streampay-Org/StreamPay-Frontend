/**
 * Inbound webhook event deduplication store.
 *
 * Tracks processed `eventId`s with a TTL so duplicate deliveries are
 * acknowledged idempotently without re-running handlers.
 *
 * Backed by an interface so a distributed store (e.g., Redis) can be
 * plugged in without changing callers.
 */

export const DEFAULT_WEBHOOK_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WebhookInboundStore {
  /** Returns true if `eventId` is currently recorded and has not expired. */
  seen(eventId: string): Promise<boolean> | boolean;
  /** Records `eventId` as seen for `ttlMs` milliseconds. */
  markSeen(eventId: string, ttlMs?: number): Promise<void> | void;
  /** Removes `eventId` from the store (e.g., when a handler fails so the sender can retry). */
  unmark(eventId: string): Promise<void> | void;
  /**
   * Atomically checks whether `eventId` has already been seen and, if not,
   * marks it as seen. Returns `true` if newly marked (caller should process),
   * or `false` if it was already seen (duplicate).
   */
  tryMarkSeen(eventId: string, ttlMs?: number): Promise<boolean> | boolean;
  /** Clears all entries (primarily for tests). */
  clear(): Promise<void> | void;
}

export class InMemoryWebhookInboundStore implements WebhookInboundStore {
  private readonly entries = new Map<string, number>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = DEFAULT_WEBHOOK_DEDUPE_TTL_MS) {
    this.defaultTtlMs = defaultTtlMs;
  }

  seen(eventId: string): boolean {
    const expiresAt = this.entries.get(eventId);
    if (expiresAt === undefined) {
      return false;
    }
    if (Date.now() >= expiresAt) {
      this.entries.delete(eventId);
      return false;
    }
    return true;
  }

  markSeen(eventId: string, ttlMs: number = this.defaultTtlMs): void {
    this.evictExpired();
    const effectiveTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : this.defaultTtlMs;
    this.entries.set(eventId, Date.now() + effectiveTtl);
  }

  tryMarkSeen(eventId: string, ttlMs: number = this.defaultTtlMs): boolean {
    if (this.seen(eventId)) {
      return false;
    }
    this.markSeen(eventId, ttlMs);
    return true;
  }

  unmark(eventId: string): void {
    this.entries.delete(eventId);
  }

  clear(): void {
    this.entries.clear();
  }

  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [id, expiresAt] of this.entries.entries()) {
      if (now >= expiresAt) {
        this.entries.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  size(): number {
    this.evictExpired();
    return this.entries.size;
  }
}

let activeStore: WebhookInboundStore = new InMemoryWebhookInboundStore();

export function getWebhookInboundStore(): WebhookInboundStore {
  return activeStore;
}

export function setWebhookInboundStore(store: WebhookInboundStore): void {
  activeStore = store;
}

export function resetWebhookInboundStore(): void {
  activeStore = new InMemoryWebhookInboundStore();
}
