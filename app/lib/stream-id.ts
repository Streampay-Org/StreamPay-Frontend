import { randomBytes } from "crypto";

/**
 * Generate a cryptographically secure unique stream identifier.
 * Format: stream-<32 hex chars> (16 random bytes, 128 bits of entropy)
 * Matches ^stream-[a-z0-9]{20,}$ and conforms to decodeCompositeCursor's /^[\w-]{1,128}$/ rule.
 */
export function newStreamId(): string {
  return `stream-${randomBytes(16).toString("hex")}`;
}
