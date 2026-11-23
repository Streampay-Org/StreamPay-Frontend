import type { Stream, StreamStatus } from "@/app/types/openapi";

export const STREAM_STATUSES: readonly StreamStatus[] = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const;

export interface TokenTotals {
  /** Sum of `totalAmount` in base units as a base-10 integer string. */
  escrowed: string;
  /** Sum of `releasedAmount` in base units as a base-10 integer string. */
  released: string;
}

export interface StreamStats {
  /** Number of visible streams per status. */
  counts: Record<StreamStatus, number>;
  /** Per-token aggregate totals in base units as base-10 integer strings. */
  totals: Record<string, TokenTotals>;
  /** Number of streams whose amounts could not be parsed as non-negative BigInts. */
  skipped: number;
}

export type StreamStatsInput = Pick<
  Stream,
  "status" | "token" | "totalAmount" | "releasedAmount" | "vestedAmount"
>;

const UNSIGNED_INT_PATTERN = /^\d+$/;

function parseBaseUnitBigInt(raw: string | undefined): bigint | null {
  if (raw === undefined) {
    return 0n;
  }
  const trimmed = raw.trim();
  if (!UNSIGNED_INT_PATTERN.test(trimmed)) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pure, exact BigInt aggregation of stream counts by status and escrowed/released
 * totals per token. Never uses floating-point arithmetic.
 *
 * Streams with missing `totalAmount` / `releasedAmount` default those fields to `0n`.
 * Streams with present but unparsable amount strings are still counted by status,
 * excluded from token totals, and tallied in `skipped`.
 */
export function aggregateStreamStats(streams: Iterable<StreamStatsInput>): StreamStats {
  const counts: Record<StreamStatus, number> = {
    draft: 0,
    active: 0,
    paused: 0,
    ended: 0,
    withdrawn: 0,
    cancelled: 0,
  };

  const tokenAccumulators = new Map<string, { escrowed: bigint; released: bigint }>();
  let skipped = 0;

  for (const stream of streams) {
    if (stream.status in counts) {
      counts[stream.status] += 1;
    }

    const escrowed = parseBaseUnitBigInt(stream.totalAmount);
    const released = parseBaseUnitBigInt(stream.releasedAmount);

    if (escrowed === null || released === null) {
      skipped += 1;
      continue;
    }

    const tokenKey = stream.token?.trim() || "XLM";
    const existing = tokenAccumulators.get(tokenKey);
    if (existing) {
      existing.escrowed += escrowed;
      existing.released += released;
    } else {
      tokenAccumulators.set(tokenKey, { escrowed, released });
    }
  }

  const totals: Record<string, TokenTotals> = {};
  for (const [token, acc] of tokenAccumulators.entries()) {
    totals[token] = {
      escrowed: acc.escrowed.toString(),
      released: acc.released.toString(),
    };
  }

  return { counts, totals, skipped };
}
