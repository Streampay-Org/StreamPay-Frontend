import type { Stream, StreamStatus } from "@/app/types/openapi";
import { computeCancellationSplit, type CancelInput } from "@/app/lib/cancel-stream";
import { resolveEscrowState, type EscrowState } from "@/app/lib/escrow-state";
import { computeWithdraw, type WithdrawErrorCode, type WithdrawInput } from "@/app/lib/recipient-withdraw";
import { transition } from "@/app/lib/state-machine";

export const I128_MAX = (1n << 127n) - 1n;

export const WITHDRAW_ERROR_STATUS: Record<WithdrawErrorCode, number> = {
  RECIPIENT_AUTH_REQUIRED: 403,
  ZERO_AMOUNT: 422,
  OVER_WITHDRAW: 422,
  INVALID_ESCROW_STATE: 422,
  NO_WITHDRAWABLE_BALANCE: 409,
  INVALID_STREAM_STATE: 409,
};

export interface OutcomePreviewError {
  ok: false;
  code: string;
  message: string;
  httpStatus: number;
  legacyCode?: string;
}

export interface CancelOutcomePreview {
  action: "cancel";
  allowed: true;
  currentStatus: StreamStatus;
  nextStatus: StreamStatus;
  token: string;
  totalAmount: string;
  releasedAmount: string;
  vestedAmount: string;
  recipientPayout: string;
  senderRefund: string;
  escrowDrained: string;
  asOf: string;
}

export interface SettleOutcomePreview {
  action: "settle";
  allowed: true;
  currentStatus: StreamStatus;
  nextStatus: StreamStatus;
  token: string;
  totalAmount: string;
  releasedAmount: string;
  vestedAmount: string;
  withdrawableAmount: string;
  unvestedAmount: string;
  asOf: string;
}

export interface WithdrawOutcomePreview {
  action: "withdraw";
  allowed: true;
  currentStatus: StreamStatus;
  nextStatus: StreamStatus;
  token: string;
  totalAmount: string;
  releasedAmount: string;
  vestedAmount: string;
  withdrawableAmount: string;
  amountPaidOut: string;
  newReleasedAmount: string;
  remainingEscrow: string;
  asOf: string;
}

export type OutcomePreviewResult<T> = { ok: true; data: T } | OutcomePreviewError;

/**
 * Shared input builder for cancellation split computation so preview and
 * mutating POST /cancel routes cannot drift.
 */
export function buildCancelInput(stream: Stream, escrow: EscrowState): CancelInput {
  return {
    totalAmount: escrow.total,
    releasedAmount: escrow.released,
    vestedAmount: escrow.vested,
    token: stream.token ?? "XLM",
    senderAddress: stream.senderAddress ?? "",
    recipientAddress: stream.recipient,
  };
}

/**
 * Shared input builder for withdrawal computation so preview and mutating
 * POST /withdraw routes cannot drift.
 */
export function buildWithdrawInput(
  stream: Stream,
  escrow: EscrowState,
  options: {
    requestedAmount?: bigint | null;
    now: Date;
    callerAddress?: string;
  },
): WithdrawInput {
  return {
    totalAmount: escrow.total,
    releasedAmount: escrow.released,
    vestedAmount: escrow.vested,
    requestedAmount: options.requestedAmount,
    token: stream.token ?? "XLM",
    recipientAddress: stream.recipient,
    callerAddress: options.callerAddress ?? stream.recipient,
    endTime: stream.endTime,
    now: options.now,
  };
}

/**
 * Parse a non-negative raw i128 integer string (used for optional withdraw
 * amount in both POST body and GET preview query string).
 */
export function parseRawI128Amount(
  value: unknown,
): { ok: true; requestedAmount?: bigint } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true };
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return {
      ok: false,
      message: "amount must be a non-negative raw i128 integer string.",
    };
  }

  let requestedAmount: bigint;
  try {
    requestedAmount = BigInt(value);
  } catch {
    return {
      ok: false,
      message: "amount must be a non-negative raw i128 integer string.",
    };
  }

  if (requestedAmount > I128_MAX) {
    return { ok: false, message: "amount exceeds the maximum i128 value." };
  }

  return { ok: true, requestedAmount };
}

/**
 * Pure read-only preview for cancelling a stream at `now`.
 */
export function previewCancelOutcome(
  stream: Stream,
  now: Date,
): OutcomePreviewResult<CancelOutcomePreview> {
  const transitionResult = transition(stream.status, "cancel");
  if (!transitionResult.ok) {
    return {
      ok: false,
      code: transitionResult.code,
      message: transitionResult.error,
      httpStatus: 409,
    };
  }

  const escrowResult = resolveEscrowState(stream, now);
  if (!escrowResult.ok) {
    return {
      ok: false,
      code: "ESCROW_STATE_UNAVAILABLE",
      message: "The stream's persisted escrow amounts or vesting schedule are unavailable.",
      httpStatus: 422,
    };
  }

  const escrow = escrowResult.value;
  const input = buildCancelInput(stream, escrow);
  const cancelResult = computeCancellationSplit(stream, input);

  if (!cancelResult.ok) {
    return {
      ok: false,
      code: cancelResult.code,
      message: cancelResult.message,
      httpStatus: cancelResult.code === "ALREADY_TERMINAL" ? 409 : 422,
    };
  }

  const { split } = cancelResult;
  return {
    ok: true,
    data: {
      action: "cancel",
      allowed: true,
      currentStatus: stream.status,
      nextStatus: transitionResult.nextStatus,
      token: input.token,
      totalAmount: escrow.total.toString(),
      releasedAmount: escrow.released.toString(),
      vestedAmount: escrow.vested.toString(),
      recipientPayout: split.recipientPayout.toString(),
      senderRefund: split.senderRefund.toString(),
      escrowDrained: split.escrowDrained.toString(),
      asOf: now.toISOString(),
    },
  };
}

/**
 * Pure read-only preview for settling a stream at `now`.
 */
export function previewSettleOutcome(
  stream: Stream,
  now: Date,
): OutcomePreviewResult<SettleOutcomePreview> {
  const transitionResult = transition(stream.status, "settle");
  if (!transitionResult.ok) {
    return {
      ok: false,
      code: transitionResult.code,
      message: transitionResult.error,
      httpStatus: 409,
      legacyCode: "INVALID_STREAM_STATE",
    };
  }

  const escrowResult = resolveEscrowState(stream, now);
  if (!escrowResult.ok) {
    return {
      ok: false,
      code: "ESCROW_STATE_UNAVAILABLE",
      message: "The stream's persisted escrow amounts or vesting schedule are unavailable.",
      httpStatus: 422,
    };
  }

  const escrow = escrowResult.value;
  if (escrow.released < 0n || escrow.vested < escrow.released || escrow.total < escrow.vested) {
    return {
      ok: false,
      code: "INVALID_ESCROW_STATE",
      message:
        `Escrow invariant violated: expected 0 ≤ releasedAmount(${escrow.released}) ` +
        `≤ vestedAmount(${escrow.vested}) ≤ totalAmount(${escrow.total}).`,
      httpStatus: 422,
    };
  }

  const withdrawableAmount = escrow.vested - escrow.released;
  const unvestedAmount = escrow.total - escrow.vested;

  return {
    ok: true,
    data: {
      action: "settle",
      allowed: true,
      currentStatus: stream.status,
      nextStatus: transitionResult.nextStatus,
      token: stream.token ?? "XLM",
      totalAmount: escrow.total.toString(),
      releasedAmount: escrow.released.toString(),
      vestedAmount: escrow.vested.toString(),
      withdrawableAmount: withdrawableAmount.toString(),
      unvestedAmount: unvestedAmount.toString(),
      asOf: now.toISOString(),
    },
  };
}

/**
 * Pure read-only preview for withdrawing from a stream at `now`.
 */
export function previewWithdrawOutcome(
  stream: Stream,
  now: Date,
  requestedAmount?: bigint | null,
): OutcomePreviewResult<WithdrawOutcomePreview> {
  const transitionResult = transition(stream.status, "withdraw");
  if (!transitionResult.ok) {
    return {
      ok: false,
      code: transitionResult.code,
      message: transitionResult.error,
      httpStatus: 409,
    };
  }

  if (stream.status === "withdrawn") {
    return {
      ok: false,
      code: "INVALID_STREAM_STATE",
      message: "Stream is in terminal state 'withdrawn' — no funds available for withdrawal.",
      httpStatus: 409,
    };
  }

  const escrowResult = resolveEscrowState(stream, now);
  if (!escrowResult.ok) {
    return {
      ok: false,
      code: "INVALID_ESCROW_STATE",
      message: "Escrow state for this stream is unknown; refusing to compute a withdrawal.",
      httpStatus: WITHDRAW_ERROR_STATUS.INVALID_ESCROW_STATE,
    };
  }

  const escrow = escrowResult.value;
  const input = buildWithdrawInput(stream, escrow, {
    requestedAmount,
    now,
  });
  const outcome = computeWithdraw(stream, input);

  if (!outcome.ok) {
    return {
      ok: false,
      code: outcome.code,
      message: outcome.message,
      httpStatus: WITHDRAW_ERROR_STATUS[outcome.code],
    };
  }

  const withdrawableAmount = escrow.vested - escrow.released;
  const remainingEscrow = escrow.total - outcome.result.newReleasedAmount;

  return {
    ok: true,
    data: {
      action: "withdraw",
      allowed: true,
      currentStatus: stream.status,
      nextStatus: transitionResult.nextStatus,
      token: input.token,
      totalAmount: escrow.total.toString(),
      releasedAmount: escrow.released.toString(),
      vestedAmount: escrow.vested.toString(),
      withdrawableAmount: withdrawableAmount.toString(),
      amountPaidOut: outcome.result.amountPaidOut.toString(),
      newReleasedAmount: outcome.result.newReleasedAmount.toString(),
      remainingEscrow: remainingEscrow.toString(),
      asOf: now.toISOString(),
    },
  };
}
