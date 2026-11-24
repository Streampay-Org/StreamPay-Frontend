/**
 * identicon.ts
 *
 * Deterministic, offline identicon generation for stream recipients.
 *
 * Recipients in `StreamRowData` are either a Stellar public key (`G...`) or a
 * human-readable display name/label (e.g. "Ada Creative Studio") — never a
 * URL. There is nothing to fetch a real favicon from, and generating one
 * from unvalidated user input would mean making a network request keyed off
 * arbitrary strings (a potential SSRF / tracking vector). Instead we derive
 * a stable "identicon" — a coloured badge with initials — purely from the
 * recipient string, client-side, with no network access at all.
 *
 * The same recipient always produces the same initials and the same palette
 * index, so a given recipient's badge stays visually consistent across the
 * app and across sessions.
 */

/** Number of colour pairs defined in `globals.css` (`--identicon-0` … `--identicon-{N-1}`). */
export const IDENTICON_PALETTE_SIZE = 8;

/**
 * Small, dependency-free string hash (FNV-1a, 32-bit).
 *
 * Not cryptographic — we only need a stable, well-distributed integer to
 * index into a fixed colour palette and to seed initials selection.
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    // hash *= 16777619 (FNV prime), done with shifts to stay in 32-bit ints
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) | 0;
  }
  // Coerce to an unsigned 32-bit integer.
  return hash >>> 0;
}

/** Deterministic palette index (`0..IDENTICON_PALETTE_SIZE-1`) for a given recipient. */
export function getIdenticonPaletteIndex(recipient: string): number {
  if (recipient.length === 0) return 0;
  return hashSeed(recipient) % IDENTICON_PALETTE_SIZE;
}

// Loose match for a Stellar-style public key: starts with "G", followed by
// uppercase letters/digits only, long enough that it couldn't be a display
// name. Intentionally lenient (not a strict 56-char StrKey check) since this
// only needs to pick initials sensibly, not validate the key.
const STELLAR_PUBLIC_KEY_RE = /^G[A-Z0-9]{19,}$/;

/**
 * Derive up to two display initials from a recipient string.
 *
 * - Stellar public keys (`G...`) use the first character plus the first
 *   character after the key prefix, uppercased (e.g. `GAHJ...` → `GA`).
 * - Display names use the first letter of up to the first two
 *   whitespace-separated words (e.g. "Ada Creative Studio" → `AC`).
 * - Falls back to `"?"` for empty/whitespace-only input.
 */
export function getRecipientInitials(recipient: string): string {
  const trimmed = recipient.trim();
  if (trimmed.length === 0) return "?";

  if (STELLAR_PUBLIC_KEY_RE.test(trimmed)) {
    return trimmed.slice(0, 2).toUpperCase();
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("");

  return (initials || trimmed.charAt(0)).toUpperCase();
}

export interface RecipientIdenticon {
  /** 0/1/2 uppercase characters shown inside the badge. */
  initials: string;
  /** Index into the `--identicon-N-*` CSS custom property pairs. */
  paletteIndex: number;
}

/** Convenience wrapper combining initials + palette index for a recipient. */
export function getRecipientIdenticon(recipient: string): RecipientIdenticon {
  return {
    initials: getRecipientInitials(recipient),
    paletteIndex: getIdenticonPaletteIndex(recipient),
  };
}
