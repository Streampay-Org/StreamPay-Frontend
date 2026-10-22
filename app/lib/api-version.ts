import type { Stream, StreamStatus, StreamAction } from "@/app/types/openapi";
import { transition } from "@/app/lib/state-machine";
import { logger } from "@/app/lib/logger";

/**
 * V1 sunset dates for deprecation policy enforcement.
 * Used by CI contract tests and v1 middleware.
 */
export const V1_DEPRECATION_DATE = new Date("2026-01-01T00:00:00Z");
export const V1_SUNSET_DATE = new Date("2026-12-31T23:59:59Z");

/**
 * API versioning utilities.
 *
 * v1 → v2 field mapping for stream objects:
 *   - `actions`        → `allowed_actions`  (renamed)
 *   - `createdAt`      → `created_at`       (snake_case)
 *   - (new)            → `settlement`       (null until settled)
 */

/** Raw stream shape returned by the data layer / v1 contract. */
export interface StreamV1 {
  id: string;
  recipient: string;
  rate: string;
  status: string;
  actions?: string[];
  nextAction?: string;
  createdAt: string;
  senderAddress?: string | null;
  ownership?: "individual" | "org" | "unclaimed";
}

/** v2 wire shape � the canonical contract for /api/v2/streams. */
export interface StreamV2 {
  id: string;
  recipient: string;
  rate: string;
  status: StreamStatus;
  /** Legal actions for `status`, derived from the state-machine table. */
  allowed_actions: string[];
  /** Single next-step hint (unchanged from v1 `nextAction`). */
  next_action?: string | null;
  /** ISO-8601 timestamp; replaces v1 `createdAt`. */
  created_at: string;
  /**
   * Settlement details once a stream has been settled, otherwise `null`.
   * Clients must handle `null` explicitly.
   */
  settlement: StreamSettlement | null;
  senderAddress?: string | null;
  ownership?: "individual" | "org" | "unclaimed";
}

export interface StreamSettlement {
  tx_hash: string;
  settled_at: string;
  /** Raw-unit amount string. */
  amount: string;
  currency: string;
}

/** Thrown when a stream cannot be faithfully projected to v2 (e.g. unknown status). */
export class ProjectionError extends Error {
  readonly code = "PROJECTION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

const STREAM_STATUSES: readonly StreamStatus[] = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
];
const STREAM_ACTIONS: readonly StreamAction[] = [
  "start",
  "pause",
  "stop",
  "settle",
  "withdraw",
  "cancel",
];

/** Actions that change the stream's status according to the state-machine table. */
function allowedActionsFor(status: StreamStatus): string[] {
  return STREAM_ACTIONS.filter((action) => {
    const result = transition(status, action);
    return result.ok && result.nextStatus !== status;
  });
}

/** Convert a v1 stream object to the v2 wire shape. Pure: no store access. */
export function toV2Stream(v1: StreamV1): StreamV2 {
  if (!STREAM_STATUSES.includes(v1.status as StreamStatus)) {
    logger.warn("Unknown stream status in v2 projection", {
      streamId: v1.id,
      status: v1.status,
    });
    throw new ProjectionError(`Unknown stream status '${v1.status}'`);
  }
  const status = v1.status as StreamStatus;
  const allowedActions = allowedActionsFor(status);

  const settlement: StreamSettlement | null = v1.settlementTxHash
    ? {
        tx_hash: v1.settlementTxHash,
        settled_at: v1.updatedAt ?? v1.createdAt,
        amount: v1.releasedAmount ?? v1.totalAmount ?? "0",
        currency: v1.token ?? "XLM",
      }
    : null;

  return {
    ...(v1 as any),
    id: v1.id,
    recipient: v1.recipient,
    rate: v1.rate,
    status,
    allowed_actions: allowedActions,
    actions: allowedActions,
    next_action: v1.nextAction ?? null,
    created_at: v1.createdAt,
    createdAt: v1.createdAt,
    settlement: null,
    senderAddress: v1.senderAddress ?? null,
    ownership: v1.ownership,
  };
}
/** Convert a db Stream object to the StreamV1 shape. */
export function dbStreamToV1(stream: Stream): StreamV1 {
  return {
    ...(stream as any),
    id: stream.id,
    recipient: stream.recipient,
    rate: stream.rate,
    status: stream.status as StreamV1["status"],
    actions: stream.nextAction ? [stream.nextAction] : [],
    createdAt: stream.createdAt,
    senderAddress: stream.senderAddress ?? null,
    ownership: stream.ownership,
  };
}
