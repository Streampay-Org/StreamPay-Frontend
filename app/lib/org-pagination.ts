/**
 * Keyset pagination helpers for organisation and organisation-member list routes.
 *
 * Uses opaque base64 composite cursors (`<timestamp>|<id>`) via
 * `encodeCompositeCursor` / `decodeCompositeCursor` from `@/app/lib/db`.
 * Sorting and cursor filtering share the same total order so walking pages
 * with `nextCursor` never produces duplicates or gaps, even when items are
 * inserted or removed between requests.
 */

import { decodeCompositeCursor, encodeCompositeCursor } from "@/app/lib/db";

export const DEFAULT_ORG_PAGE_LIMIT = 20;
export const MIN_ORG_PAGE_LIMIT = 1;
export const MAX_ORG_PAGE_LIMIT = 100;

/** Keyset position `(timestamp, id)` in a deterministically sorted collection. */
export interface OrgCursor {
  timestamp: string;
  id: string;
}

export interface PaginateOptions {
  limit: number;
  cursor?: OrgCursor | null;
}

export interface PaginateResult<T> {
  page: T[];
  hasNext: boolean;
  nextCursor: string | null;
}

export interface ParsedPaginationParams {
  limit: number;
  cursor: OrgCursor | null;
}

export type ParsePaginationResult =
  | { ok: true; value: ParsedPaginationParams }
  | { ok: false; code: "VALIDATION_ERROR" | "INVALID_CURSOR"; message: string };

/** Raised when a cursor cannot be decoded into a valid keyset position. */
export class InvalidOrgCursorError extends Error {
  constructor(message = "Malformed pagination cursor.") {
    super(message);
    this.name = "InvalidOrgCursorError";
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareKeys(left: OrgCursor, right: OrgCursor): number {
  const timeCompare = compareStrings(left.timestamp, right.timestamp);
  return timeCompare !== 0 ? timeCompare : compareStrings(left.id, right.id);
}

/** Encodes a keyset position as an opaque base64 composite cursor. */
export function encodeOrgCursor(cursor: OrgCursor): string {
  return encodeCompositeCursor(cursor.timestamp, cursor.id);
}

/**
 * Decodes an opaque base64 composite cursor into a keyset position.
 *
 * @throws {InvalidOrgCursorError} when the cursor is not canonical base64 or
 *   does not match the `<ISO-8601 timestamp>|<id>` format.
 */
export function decodeOrgCursor(cursor: string): OrgCursor {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new InvalidOrgCursorError("Cursor must be a non-empty string.");
  }

  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64") !== cursor) {
    throw new InvalidOrgCursorError("Cursor is not valid base64.");
  }

  try {
    return decodeCompositeCursor(cursor);
  } catch {
    throw new InvalidOrgCursorError("Malformed pagination cursor.");
  }
}

/**
 * Parses and validates `limit` and `cursor` query parameters from a request URL.
 */
export function parseOrgPaginationParams(
  searchParams: URLSearchParams,
): ParsePaginationResult {
  let limit = DEFAULT_ORG_PAGE_LIMIT;
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: `Query parameter 'limit' must be an integer between ${MIN_ORG_PAGE_LIMIT} and ${MAX_ORG_PAGE_LIMIT}.`,
      };
    }
    const parsed = Number.parseInt(rawLimit, 10);
    if (parsed < MIN_ORG_PAGE_LIMIT || parsed > MAX_ORG_PAGE_LIMIT) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: `Query parameter 'limit' must be an integer between ${MIN_ORG_PAGE_LIMIT} and ${MAX_ORG_PAGE_LIMIT}.`,
      };
    }
    limit = parsed;
  }

  let cursor: OrgCursor | null = null;
  const rawCursor = searchParams.get("cursor");
  if (rawCursor !== null) {
    try {
      cursor = decodeOrgCursor(rawCursor);
    } catch (error) {
      return {
        ok: false,
        code: "INVALID_CURSOR",
        message:
          error instanceof InvalidOrgCursorError
            ? error.message
            : "Malformed pagination cursor.",
      };
    }
  }

  return { ok: true, value: { limit, cursor } };
}

/**
 * Sorts `items` deterministically by `(timestamp, id)` ascending, applies an
 * optional keyset cursor, and returns a single page with pagination metadata.
 */
export function paginateByKeyset<T>(
  items: readonly T[],
  getKey: (item: T) => OrgCursor,
  options: PaginateOptions,
): PaginateResult<T> {
  const sorted = [...items].sort((left, right) =>
    compareKeys(getKey(left), getKey(right)),
  );

  const afterCursor = options.cursor
    ? sorted.filter((item) => compareKeys(getKey(item), options.cursor!) > 0)
    : sorted;

  const page = afterCursor.slice(0, options.limit);
  const hasNext = afterCursor.length > options.limit;
  const nextCursor =
    hasNext && page.length > 0
      ? encodeOrgCursor(getKey(page[page.length - 1]))
      : null;

  return { page, hasNext, nextCursor };
}
