/**
 * Pagination cursor helpers for the stream list routes.
 *
 * The list routes used to encode a bare stream id in the cursor and decode it
 * with `Buffer.from(cursor, "base64")`, which never throws. A malformed cursor
 * therefore decoded to a junk id, and an id that no longer existed silently
 * restarted the listing at page one, so a client walking the pages could loop
 * forever or see duplicates.
 *
 * Cursors are now keyset cursors: the pair `(createdAt, id)` of the last row of
 * the previous page. The pair survives the deletion of that row, so paging
 * resumes at the right place, and it is compared with a total order, so a row
 * inserted while the client walks the pages can never be returned twice.
 */

import { decodeCompositeCursor, encodeCompositeCursor } from "@/app/lib/db";

/** A `(createdAt, id)` keyset position in the sorted stream list. */
export interface StreamCursor {
  /** ISO-8601 creation timestamp of the last row of the previous page. */
  createdAt: string;
  /** Id of the last row of the previous page. */
  id: string;
}

/** Raised when a cursor cannot be decoded into a usable keyset position. */
export class InvalidStreamCursorError extends Error {
  constructor(message = "Cursor is not a valid pagination cursor.") {
    super(message);
    this.name = "InvalidStreamCursorError";
  }
}

/**
 * Legacy (pre-keyset) cursors encoded a bare stream id.
 * They are accepted for one release and then removed.
 */
const LEGACY_STREAM_ID_PATTERN = /^stream-[\w-]+$/;

export interface DecodeStreamCursorOptions {
  /**
   * Resolves a legacy plain-id cursor to its keyset position.
   * Returns `null` when the id is unknown, which makes the cursor invalid.
   */
  resolveLegacyId?: (id: string) => StreamCursor | null;
}

/** Encodes a keyset position as an opaque cursor. */
export function encodeStreamCursor(cursor: StreamCursor): string {
  return encodeCompositeCursor(cursor.createdAt, cursor.id);
}

/**
 * Decodes a cursor into a keyset position.
 *
 * @throws {InvalidStreamCursorError} when the cursor is not decodable, is not a
 *   well-formed keyset cursor, or is a legacy cursor for an unknown stream.
 */
export function decodeStreamCursor(
  cursor: string,
  options: DecodeStreamCursorOptions = {},
): StreamCursor {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new InvalidStreamCursorError("Cursor must be a non-empty string.");
  }

  // Reject anything that is not canonical base64. `Buffer.from(x, "base64")`
  // silently ignores invalid characters, so the round-trip is the only reliable
  // way to tell a real cursor from arbitrary text.
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== cursor) {
    throw new InvalidStreamCursorError("Cursor is not valid base64.");
  }

  // Current format: base64("<createdAt>|<id>").
  try {
    const { timestamp, id } = decodeCompositeCursor(cursor);
    return { createdAt: timestamp, id };
  } catch {
    // Not a keyset cursor; fall through to the legacy format.
  }

  // Legacy format: base64("<stream id>"). Accepted for one release.
  if (LEGACY_STREAM_ID_PATTERN.test(decoded)) {
    const resolved = options.resolveLegacyId?.(decoded) ?? null;
    if (resolved) {
      return resolved;
    }
    throw new InvalidStreamCursorError(
      "Cursor refers to a stream that no longer exists.",
    );
  }

  throw new InvalidStreamCursorError();
}

/**
 * Returns true when `row` sorts strictly after `cursor`.
 *
 * `createdAt` is an ISO-8601 timestamp, so a lexicographic comparison is a
 * chronological one; the id breaks ties between rows created in the same
 * millisecond.
 */
export function isAfterCursor(
  row: { createdAt: string; id: string },
  cursor: StreamCursor,
): boolean {
  if (row.createdAt !== cursor.createdAt) {
    return row.createdAt > cursor.createdAt;
  }
  return row.id > cursor.id;
}