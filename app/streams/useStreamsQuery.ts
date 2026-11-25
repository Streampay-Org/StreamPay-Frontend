"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isSortOption, type SortOption } from "../components/SortDropdown";
import type { StreamStatus } from "../types/openapi";

/**
 * URL-backed state for the streams list.
 *
 * The page mirrors its filter state into the query string so a reload or a
 * shared link restores the same view. Writes always use `router.replace` with
 * `{ scroll: false }` so typing in the search box never adds history entries.
 */

export const STREAM_STATUSES = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const satisfies readonly StreamStatus[];

export type StreamsQuery = {
  tag: string | null;
  status: StreamStatus | null;
  q: string;
  sort: SortOption;
};

export const DEFAULT_STREAMS_QUERY: StreamsQuery = {
  tag: null,
  status: null,
  q: "",
  sort: "newest",
};

export function isStreamStatus(value: unknown): value is StreamStatus {
  return (
    typeof value === "string" &&
    (STREAM_STATUSES as readonly string[]).includes(value)
  );
}

type ReadonlyParams = Pick<URLSearchParams, "get">;

/**
 * Parses (and validates) the supported params out of a `URLSearchParams`.
 * Unknown or invalid values are ignored. Repeated params resolve to the first
 * occurrence, and surrounding whitespace is trimmed.
 */
export function parseStreamsQuery(
  params: ReadonlyParams,
  defaults: StreamsQuery = DEFAULT_STREAMS_QUERY,
): StreamsQuery {
  const tag = params.get("tag")?.trim();
  const status = params.get("status")?.trim();
  const q = params.get("q")?.trim();
  const sort = params.get("sort")?.trim();

  return {
    tag: tag ? tag : defaults.tag,
    status: isStreamStatus(status) ? status : defaults.status,
    q: q ?? defaults.q,
    sort: isSortOption(sort) ? sort : defaults.sort,
  };
}

/**
 * Serialises the query, dropping empty values and defaults so the URL stays
 * short (e.g. `?tag=vendor&status=active&q=ada`).
 */
export function serialiseStreamsQuery(
  query: StreamsQuery,
  defaults: StreamsQuery = DEFAULT_STREAMS_QUERY,
): string {
  const params = new URLSearchParams();
  const tag = query.tag?.trim();
  const q = query.q.trim();

  if (tag) params.set("tag", tag);
  if (query.status && query.status !== defaults.status) {
    params.set("status", query.status);
  }
  if (q) params.set("q", q);
  if (query.sort !== defaults.sort) params.set("sort", query.sort);

  return params.toString();
}

type UseStreamsQueryOptions = {
  /** How long to wait after the last keystroke before writing `q` to the URL. */
  searchDebounceMs?: number;
};

export function useStreamsQuery({
  searchDebounceMs = 300,
}: UseStreamsQueryOptions = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /* Depend on the serialised string, not the params object: Next can hand back
   * a new `URLSearchParams` instance on every render. */
  const rawQuery = searchParams?.toString() ?? "";
  const rawParams = useMemo(() => new URLSearchParams(rawQuery), [rawQuery]);

  const parsedQuery = useMemo(() => parseStreamsQuery(rawParams), [rawParams]);
  /* Only a valid sort param should win over the stored preference. */
  const hasSortParam = isSortOption(rawParams.get("sort"));

  /*
   * The URL is the source of truth, but `router.replace` is asynchronous: the
   * new `searchParams` arrive on a later render. Keep an optimistic copy so
   * consecutive actions (e.g. pick a tag then a status) build on each other
   * instead of overwriting the param the previous action just wrote.
   */
  const [query, setQuery] = useState(parsedQuery);
  const queryRef = useRef(query);
  /* The last `q` this hook wrote, so an echo from router.replace does not
   * overwrite keystrokes typed after that write. */
  const lastWrittenQRef = useRef(query.q);

  useEffect(() => {
    queryRef.current = parsedQuery;
    setQuery(parsedQuery);
  }, [parsedQuery]);

  const apply = useCallback(
    (next: StreamsQuery) => {
      queryRef.current = next;
      lastWrittenQRef.current = next.q;
      setQuery(next);

      const search = serialiseStreamsQuery(next);
      const base = pathname ?? "";
      router.replace(search ? `${base}?${search}` : base, { scroll: false });
    },
    [pathname, router],
  );

  /* ── Debounced free-text search ───────────────────────────────────────── */
  const [searchValue, setSearchValue] = useState(query.q);

  /* Follow external URL changes (e.g. a shared link after hydration), but
   * ignore the echo of our own debounced write. */
  useEffect(() => {
    if (query.q === lastWrittenQRef.current) return;
    lastWrittenQRef.current = query.q;
    setSearchValue(query.q);
  }, [query.q]);

  useEffect(() => {
    const trimmed = searchValue.trim();
    if (trimmed === query.q) return;

    const timer = setTimeout(() => {
      apply({ ...queryRef.current, q: trimmed });
    }, searchDebounceMs);

    return () => clearTimeout(timer);
  }, [searchValue, query.q, searchDebounceMs, apply]);

  /* ── Immediate setters ────────────────────────────────────────────────── */
  const setTag = useCallback(
    (tag: string | null) => {
      const trimmed = tag?.trim();
      apply({ ...queryRef.current, tag: trimmed ? trimmed : null });
    },
    [apply],
  );

  const setStatus = useCallback(
    (status: StreamStatus | null) => {
      apply({
        ...queryRef.current,
        status: isStreamStatus(status) ? status : null,
      });
    },
    [apply],
  );

  const setSort = useCallback(
    (sort: SortOption) => {
      apply({
        ...queryRef.current,
        sort: isSortOption(sort) ? sort : DEFAULT_STREAMS_QUERY.sort,
      });
    },
    [apply],
  );

  /**
   * Clears the filters (tag, status, search) from the URL. The sort parameter
   * is a display preference rather than a filter, so it is preserved.
   */
  const clearFilters = useCallback(() => {
    setSearchValue("");
    apply({ ...queryRef.current, tag: null, status: null, q: "" });
  }, [apply]);

  return {
    tag: query.tag,
    status: query.status,
    q: query.q,
    sort: query.sort,
    hasSortParam,
    searchValue,
    setSearch: setSearchValue,
    setTag,
    setStatus,
    setSort,
    clearFilters,
  };
}
