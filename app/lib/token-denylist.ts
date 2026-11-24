/**
 * Access-token denylist
 *
 * `POST /api/auth/logout` revokes the presented JWT's `jti` until the token's
 * own `exp`. Entries therefore expire naturally and the store stays bounded.
 *
 * The in-memory implementation is the default. It is intentionally shaped as a
 * small interface so a Redis-backed implementation can replace it without
 * touching `tryAuthenticateRequest`.
 */

export interface TokenDenylist {
  /** Revokes `jti` until `expSeconds` (JWT `exp`, seconds since the epoch). */
  revoke(jti: string, expSeconds: number): void;
  /** Returns `true` while `jti` is revoked. */
  isRevoked(jti: string): boolean;
}

interface DenylistEntry {
  expiresAtMs: number;
}

export interface InMemoryTokenDenylistOptions {
  /** Hard cap on retained entries; the oldest entry is evicted first. */
  maxEntries?: number;
  /** Injectable clock, in milliseconds. */
  nowFn?: () => number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

export class InMemoryTokenDenylist implements TokenDenylist {
  private readonly entries = new Map<string, DenylistEntry>();
  private readonly maxEntries: number;
  private readonly nowFn: () => number;

  constructor(options: InMemoryTokenDenylistOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  revoke(jti: string, expSeconds: number): void {
    if (!jti) return;

    const now = this.nowFn();
    this.pruneExpired(now);

    const expiresAtMs = expSeconds * 1000;
    // A token that is already expired needs no denylist entry.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return;

    this.entries.delete(jti);
    this.entries.set(jti, { expiresAtMs });
    this.enforceBound();
  }

  isRevoked(jti: string): boolean {
    if (!jti) return false;

    const now = this.nowFn();
    this.pruneExpired(now);
    return this.entries.has(jti);
  }

  /** Live entry count — used by tests to assert pruning. */
  size(): number {
    this.pruneExpired(this.nowFn());
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(now: number): void {
    for (const [jti, entry] of this.entries) {
      if (entry.expiresAtMs > now) continue;
      this.entries.delete(jti);
    }
  }

  private enforceBound(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

let activeDenylist: TokenDenylist = new InMemoryTokenDenylist();

export function getTokenDenylist(): TokenDenylist {
  return activeDenylist;
}

export function setTokenDenylist(denylist: TokenDenylist): void {
  activeDenylist = denylist;
}

export function resetTokenDenylist(): void {
  activeDenylist = new InMemoryTokenDenylist();
}
