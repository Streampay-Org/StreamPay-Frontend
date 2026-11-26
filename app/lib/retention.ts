import type { Stream } from "@/app/types/openapi";
import { getStore } from "./db";
import { isPastRetention, RETENTION_PERIOD_MS } from "./privacy";

export const DEFAULT_RETENTION_PURGE_LIMIT = 100;
export const MAX_RETENTION_PURGE_LIMIT = 500;

/**
 * PII fields scrubbed once a stream leaves the retention window. Aggregates
 * (id, amounts, status, timestamps) stay for the legal/audit trail documented
 * in docs/PRIVACY.md.
 */
export const RETAINED_PII_FIELDS = [
  "email",
  "label",
  "memo",
  "partnerId",
] as const;

export interface PurgeExpiredStreamsOptions {
  /** Clock override for deterministic runs and tests. Defaults to `Date.now()`. */
  now?: number | Date;
  /** Report what would be purged without mutating streams. Defaults to `false`. */
  dryRun?: boolean;
  /** Maximum streams to purge in one run. Defaults to 100, capped at 500. */
  limit?: number;
}

export interface PurgeExpiredStreamsResult {
  /** Streams inspected in this run. */
  scanned: number;
  /** Streams past retention that still hold PII. */
  eligible: number;
  /** Streams past retention that were already scrubbed by an earlier run. */
  alreadyScrubbed: number;
  /** Streams actually scrubbed (always 0 for a dry run). */
  purged: number;
  /** Eligible streams left for a later run because of `limit`. */
  remaining: number;
  /** Ids of the streams selected for this run, in purge order. */
  selectedIds: string[];
  /** Ids of the streams actually scrubbed (empty for a dry run). */
  purgedIds: string[];
  /** ISO timestamp of the retention cutoff (`now` minus seven years). */
  cutoff: string;
  dryRun: boolean;
  limit: number;
}

function hasRetainedPii(stream: Stream): boolean {
  return RETAINED_PII_FIELDS.some((field) => {
    const value = stream[field];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function resolveNow(now: number | Date | undefined): number {
  if (now === undefined) return Date.now();
  const value = now instanceof Date ? now.getTime() : now;
  return Number.isFinite(value) ? value : Date.now();
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RETENTION_PURGE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_RETENTION_PURGE_LIMIT);
}

/**
 * Scrub PII from streams that are past the seven-year retention window.
 *
 * Purging is idempotent: streams whose PII is already gone are counted as
 * `alreadyScrubbed` and left untouched, so a repeated run neither mutates nor
 * re-audits them. Unparsable `createdAt` values are never purged.
 */
export function purgeExpiredStreams(
  options: PurgeExpiredStreamsOptions = {}
): PurgeExpiredStreamsResult {
  const nowMs = resolveNow(options.now);
  const dryRun = options.dryRun === true;
  const limit = resolveLimit(options.limit);
  const { streams } = getStore().streamRepository;

  const expired: Stream[] = [];
  let scanned = 0;
  for (const stream of streams.values()) {
    scanned += 1;
    if (isPastRetention(stream.createdAt, nowMs)) {
      expired.push(stream);
    }
  }

  expired.sort((left, right) => {
    const byAge = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return byAge !== 0 ? byAge : left.id.localeCompare(right.id);
  });

  const eligible = expired.filter(hasRetainedPii);
  const batch = eligible.slice(0, limit);
  const selectedIds = batch.map((stream) => stream.id);

  const purgedIds: string[] = [];
  if (!dryRun) {
    const scrubbedAt = new Date(nowMs).toISOString();
    for (const stream of batch) {
      streams.set(stream.id, {
        ...stream,
        email: undefined,
        label: undefined,
        memo: undefined,
        partnerId: undefined,
        updatedAt: scrubbedAt,
      });
      purgedIds.push(stream.id);
    }
  }

  return {
    scanned,
    eligible: eligible.length,
    alreadyScrubbed: expired.length - eligible.length,
    purged: purgedIds.length,
    remaining: eligible.length - batch.length,
    selectedIds,
    purgedIds,
    cutoff: new Date(nowMs - RETENTION_PERIOD_MS).toISOString(),
    dryRun,
    limit,
  };
}
