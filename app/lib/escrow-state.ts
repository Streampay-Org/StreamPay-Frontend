import type { Stream as AppStream } from "@/app/types/openapi";

type Stream = AppStream & {
  total?: string | number | bigint;
  totalPausedMs?: string | number | bigint;
};

/**
 * Result of a vesting computation.
 *
 * - `ok`: the vested amount in stroops (bigint).
 * - `unknown`: the stream is missing timing fields and the schedule cannot be
 *   derived. Callers must surface `ESCROW_UNKNOWN` rather than inventing a
 *   schedule.
 */
export type VestedResult = { ok: true; value: bigint } | { ok: false; code: "ESCROW_UNKNOWN" };

/**
 * Resolve the effective timing fields from a stream.
 *
 * Timing fields are documented as raw strings or numbers in the API `Stream`
 * type. We normalize them to bigint milliseconds without going through a
 * floating-point intermediate.
 */
function toBigIntMs(value: unknown | undefined | null): bigint | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return null;
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") {
      return null;
    }
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Compute the vested amount for a stream at a given time.
 *
 * This is a bit-exact port of `release::vested_amount` from
 * `contracts/contracts/streampay-stream/src/release.rs`.
 *
 * Rules:
 * - Draft streams return 0.
 * - `effective_now = max(start, min(now, end))`, clamped to `paused_at`
 *   when paused.
 * - `elapsed = effective_now - start - total_paused_duration`.
 * - Result is `total * elapsed / duration` with integer division.
 *
 * Timing fields (`startTime`, `endTime`, `totalPausedMs`) are expected in
 * milliseconds. The contract works in seconds, but the ratio is invariant to
 * the unit as long as all three fields share the same unit.
 */
export function vestedAmount(stream: Stream, nowMs: number | bigint): VestedResult {
  // Drafts never vest.
  if (stream.status === "draft") {
    return { ok: true, value: 0n };
  }

  const total = toBigIntMs(stream.total);
  const start = toBigIntMs(stream.startTime);
  const end = toBigIntMs(stream.endTime);
  const totalPaused = toBigIntMs(stream.totalPausedMs) ?? 0n;
  const pausedAt = toBigIntMs(stream.pausedAt);
  const now = typeof nowMs === "bigint" ? nowMs : BigInt(Math.trunc(nowMs));

  // Fail rather than default when the schedule is unknown.
  if (total === null || start === null || end === null) {
    return { ok: false, code: "ESCROW_UNKNOWN" };
  }

  const duration = end - start;
  if (duration <= 0n) {
    // Degenerate schedule: nothing can vest.
    return { ok: true, value: 0n };
  }

  // `effective_now = max(start, min(now, end))`, clamped to `paused_at`
  // when paused.
  let effectiveNow = now > end ? end : now;
  if (effectiveNow < start) {
    effectiveNow = start;
  }
  if (pausedAt !== null && pausedAt < effectiveNow) {
    effectiveNow = pausedAt;
  }

  let elapsed = effectiveNow - start - totalPaused;
  if (elapsed < 0n) {
    elapsed = 0n;
  }
  if (elapsed > duration) {
    elapsed = duration;
  }

  // Integer division, matching the contract.
  const value = (total * elapsed) / duration;
  return { ok: true, value };
}

/** Raw-unit escrow snapshot used by cancellation and withdrawal computations. */
export interface EscrowState {
  total: bigint;
  released: bigint;
  vested: bigint;
}

export type EscrowStateResult =
  | { ok: true; value: EscrowState }
  | { ok: false; code: "ESCROW_UNKNOWN" };

/** Capture the cancellation instant; callers can replace this clock in tests. */
export function escrowNow(): Date {
  return new Date();
}

function parseAmount(value: string | undefined): bigint | null {
  return typeof value === "string" && /^-?\d+$/.test(value)
    ? BigInt(value)
    : null;
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * Resolve persisted raw escrow amounts at an injected time. A stream with a
 * vesting window uses exact integer linear vesting; legacy records without a
 * window use their persisted vested snapshot. Unknown data fails closed.
 */
export function resolveEscrowState(stream: Stream, now: Date): EscrowStateResult {
  const totalAmount = parseAmount(stream.totalAmount);
  const releasedAmount = parseAmount(stream.releasedAmount);
  if (totalAmount === null || releasedAmount === null || !Number.isFinite(now.getTime())) {
    return { ok: false, code: "ESCROW_UNKNOWN" };
  }

  let vestedAmount: bigint;
  if (stream.startTime !== undefined || stream.endTime !== undefined) {
    const start = parseTime(stream.startTime);
    const end = parseTime(stream.endTime);
    if (start === null || end === null || end <= start) {
      return { ok: false, code: "ESCROW_UNKNOWN" };
    }
    const pause = stream.pausedAt === undefined ? null : parseTime(stream.pausedAt);
    if (stream.pausedAt !== undefined && pause === null) {
      return { ok: false, code: "ESCROW_UNKNOWN" };
    }
    const pausedDuration = stream.pausedDurationMs ?? 0;
    if (!Number.isSafeInteger(pausedDuration) || pausedDuration < 0) {
      return { ok: false, code: "ESCROW_UNKNOWN" };
    }
    const effectiveNow = pause === null ? now.getTime() : Math.min(now.getTime(), pause);
    const duration = end - start;
    const elapsed = Math.max(0, Math.min(effectiveNow - start - pausedDuration, duration));
    vestedAmount = totalAmount * BigInt(elapsed) / BigInt(duration);
  } else {
    const snapshot = parseAmount(stream.vestedAmount);
    if (snapshot === null) return { ok: false, code: "ESCROW_UNKNOWN" };
    vestedAmount = snapshot;
  }

  return { ok: true, value: { total: totalAmount, released: releasedAmount, vested: vestedAmount } };
}
