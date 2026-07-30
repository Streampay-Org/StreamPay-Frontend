"use client";

import { getRecipientIdenticon } from "../lib/identicon";

/**
 * RecipientAvatar
 *
 * Small, deterministic identicon badge for a stream recipient — a coloured
 * circle with up to two initials, derived from the recipient string alone
 * (see `lib/identicon.ts`). No network request is made: recipients are
 * Stellar public keys or free-text labels, not URLs, so there is no favicon
 * to safely fetch, and generating one client-side avoids leaking recipient
 * identifiers to a third-party favicon service.
 *
 * Purely decorative: the recipient's full name/address is already rendered
 * as visible text next to every avatar (e.g. the `StreamRow` heading), so
 * the badge is hidden from assistive technology (`aria-hidden`) to avoid
 * announcing the same identity twice.
 */

export interface RecipientAvatarProps {
  /** Recipient display name or Stellar public key. */
  recipient: string;
  /** Diameter in px. Defaults to 36. */
  size?: number;
  /** Optional class forwarded to the wrapper. */
  className?: string;
}

export function RecipientAvatar({ recipient, size = 36, className = "" }: RecipientAvatarProps) {
  const { initials, paletteIndex } = getRecipientIdenticon(recipient);

  return (
    <span
      className={`recipient-avatar ${className}`.trim()}
      aria-hidden="true"
      data-palette-index={paletteIndex}
      style={{
        // Read from the fixed CSS palette so light/dark themes and contrast
        // are handled entirely in `globals.css`, not computed in JS.
        backgroundColor: `var(--identicon-${paletteIndex}-bg)`,
        color: `var(--identicon-${paletteIndex}-fg)`,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials}
    </span>
  );
}

export default RecipientAvatar;
