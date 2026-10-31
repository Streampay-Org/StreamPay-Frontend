/**
 * @module state-machine
 *
 * Authoritative stream lifecycle state machine for StreamPay.
 *
 * ## Stream lifecycle
 * ```
 * draft ──start──► active ──pause──► paused ──start──► active
 *   └──stop──► ended ◄──stop/settle── active/paused
 *              └──withdraw──► withdrawn
 * active/paused ──cancel──► cancelled
 * ```
 * Draft streams cannot be cancelled because they have no escrowed funds;
 * their existing `STREAM_NOT_CANCELLABLE` response is preserved.
 *
 * ## Idempotent transitions
 * Certain actions are idempotent when the stream is already in the target
 * state (e.g. `start` on an `active` stream, `pause` on a `paused` stream).
 * These return `ok: true` with the unchanged status rather than an error.
 *
 * ## Usage
 * ```ts
 * const result = transition("active", "pause");
 * if (result.ok) console.log(result.nextStatus); // "paused"
 * ```
 */

import { StreamStatus, StreamAction } from "@/app/types/openapi";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Result of a state transition attempt.
 *
 * - `ok: true`  — transition is valid; `nextStatus` is the new status.
 * - `ok: false` — transition is illegal; `error` describes why.
 */
export type TransitionResult =
  | { ok: true; nextStatus: StreamStatus }
  | { ok: false; error: string; code: "ILLEGAL_TRANSITION" };

// ── Transition table ──────────────────────────────────────────────────────────

/**
 * Authoritative transition table.
 * Maps `[currentStatus][action]` → `nextStatus`.
 *
 * Only explicitly listed transitions are valid. All others are rejected
 * with `ILLEGAL_TRANSITION`.
 */
const TRANSITIONS: Partial<Record<StreamStatus, Partial<Record<StreamAction, StreamStatus>>>> = {
  draft: {
    start: "active",
    stop:  "ended",
  },
  active: {
    start:  "active",
    stop:   "ended",
    settle: "ended",
    cancel: "cancelled",
    pause:  "paused",
  },
  paused: {
    start:  "active",
    stop:   "ended",
    settle: "ended",
    cancel: "cancelled",
    pause:  "paused",
  },
  ended: {
    stop:     "ended",     // idempotent
    settle:   "ended",     // idempotent
    withdraw: "withdrawn",
  },
  withdrawn: {
    withdraw: "withdrawn", // idempotent
  },
  cancelled: {},
};

const NEXT_ACTION_PREFERENCE: Partial<Record<StreamStatus, StreamAction>> = {
  draft: "start",
  active: "pause",
  paused: "start",
  ended: "withdraw",
};

// ── Core function ─────────────────────────────────────────────────────────────

/** Return the valid actions for a status, preserving transition-table order. */
export function allowedActions(status: StreamStatus): StreamAction[] {
  return Object.keys(TRANSITIONS[status] ?? {}) as StreamAction[];
}

/** Return the preferred client action when that action is allowed by the table. */
export function nextActionFor(status: StreamStatus): StreamAction | undefined {
  const preferred = NEXT_ACTION_PREFERENCE[status];
  return preferred && allowedActions(status).includes(preferred) ? preferred : undefined;
}

/**
 * Compute the next stream status for a given action.
 *
 * **Preconditions:** `currentStatus` and `action` must be valid enum members.
 *
 * **Postconditions:**
 * - Returns `{ ok: true, nextStatus }` when the transition is valid.
 * - Returns `{ ok: false, code: "ILLEGAL_TRANSITION", error }` when the
 *   action is not permitted in the current status.
 *
 * **Idempotency:** Actions that are already applied (e.g. `pause` on a
 * `paused` stream) return `ok: true` with `nextStatus === currentStatus`.
 *
 * **Errors:**
 * - `ILLEGAL_TRANSITION` — action not permitted in current status.
 *
 * @param currentStatus - The stream's current lifecycle status.
 * @param action        - The action to apply.
 * @returns             {@link TransitionResult}
 *
 * @example
 * ```ts
 * transition("active", "pause")   // { ok: true, nextStatus: "paused" }
 * transition("draft",  "withdraw") // { ok: false, code: "ILLEGAL_TRANSITION", ... }
 * transition("paused", "pause")   // { ok: true, nextStatus: "paused" } (idempotent)
 * ```
 */
export function transition(
  currentStatus: StreamStatus,
  action: StreamAction,
): TransitionResult {
  // A transition to the same status is an idempotent success.
  const nextStatus = TRANSITIONS[currentStatus]?.[action];
  if (nextStatus !== undefined) return { ok: true, nextStatus };

  // Illegal transition
  return {
    ok: false,
    error: `Action '${action}' is illegal for a stream in '${currentStatus}' state.`,
    code: "ILLEGAL_TRANSITION",
  };
}
