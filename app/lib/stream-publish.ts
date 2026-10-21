import { randomUUID } from "crypto";
import { isDeepStrictEqual } from "util";
import { eventBus } from "@/app/lib/event-bus";
import type { ActivityEvent, Stream, StreamAction } from "@/app/types/openapi";

/**
 * Lifecycle actions that can be published. `update` is used by generic PATCH /
 * batch routes when a lifecycle field changed but no single action describes it.
 */
export type StreamChangeAction = StreamAction | "update";

/** Input for {@link publishStreamChange}. */
export interface StreamChange {
  /** Snapshot of the stream before the committed mutation. */
  before: Stream;
  /** The stream as persisted after the commit. */
  after: Stream;
  /** The lifecycle action responsible for the change. */
  action: StreamChangeAction;
  /** Optional wallet/actor that requested the change. */
  actor?: string;
  /** Optional correlation id for tracing. */
  correlationId?: string;
}

/**
 * The public projection emitted over SSE. PII fields are omitted entirely,
 * not masked, so they can never be re-identified from a live subscriber.
 */
export type PublishedStream = Omit<
  Stream,
  "email" | "label" | "memo" | "partnerId"
>;

const PII_FIELDS = ["email", "label", "memo", "partnerId"] as const;

/**
 * Lifecycle fields whose change warrants a live update. `updatedAt` is
 * deliberately excluded: every write bumps it, so including it would make
 * idempotent no-ops or PII-only edits look like lifecycle changes.
 */
const LIFECYCLE_FIELDS = [
  "status",
  "nextAction",
  "pausedAt",
  "settlementTxHash",
  "withdrawal",
  "cancellation",
  "vestedAmount",
  "releasedAmount",
] as const satisfies ReadonlyArray<keyof Stream>;

const PAST_TENSE: Record<StreamChangeAction, string> = {
  start: "started",
  pause: "paused",
  stop: "stopped",
  settle: "settled",
  withdraw: "withdrawn",
  cancel: "cancelled",
  update: "updated",
};

/**
 * Return the stream projection safe to publish to SSE subscribers.
 *
 * PII fields (`email`, `label`, `memo`, `partnerId`) are removed from the
 * object rather than replaced with a placeholder.
 *
 * @param stream - The persisted stream record.
 * @returns A copy without PII fields.
 */
export function toPublishedStream(stream: Stream): PublishedStream {
  const safe = { ...stream };
  for (const field of PII_FIELDS) {
    delete safe[field];
  }
  return safe;
}

/**
 * Whether a write changed a lifecycle field (as opposed to only `updatedAt`
 * or PII). Used to suppress emits for idempotent replays and no-op writes.
 *
 * @param before - Stream state before the write.
 * @param after - Stream state after the write.
 */
export function hasLifecycleChange(before: Stream, after: Stream): boolean {
  return LIFECYCLE_FIELDS.some(
    (field) => !isDeepStrictEqual(before[field], after[field]),
  );
}

/**
 * Infer the lifecycle action for generic update routes (PATCH / v2 batch)
 * from the before/after diff. Falls back to `update` when the change is a
 * lifecycle field that no named action describes.
 */
export function inferStreamChangeAction(
  before: Stream,
  after: Stream,
): StreamChangeAction {
  if (before.status !== after.status) {
    if (
      after.status === "ended" &&
      (!isDeepStrictEqual(before.settlementTxHash, after.settlementTxHash) ||
        !isDeepStrictEqual(before.withdrawal, after.withdrawal))
    ) {
      return "settle";
    }
    switch (after.status) {
      case "active":
        return "start";
      case "paused":
        return "pause";
      case "ended":
        return "stop";
      case "cancelled":
        return "cancel";
      case "withdrawn":
        return "withdraw";
      default:
        return "update";
    }
  }

  if (!isDeepStrictEqual(before.withdrawal, after.withdrawal)) return "withdraw";
  if (!isDeepStrictEqual(before.cancellation, after.cancellation)) return "cancel";
  if (!isDeepStrictEqual(before.settlementTxHash, after.settlementTxHash)) {
    return "settle";
  }
  return "update";
}

/**
 * Publish a committed stream change to the in-process event bus.
 *
 * Must be called **after** the write to the stream store succeeds. Emits:
 * - `stream:updated:<id>` with the redacted public projection;
 * - `settle:finished:<id>` when the stream moved into `ended` via `settle`,
 *   after the `stream:updated` event;
 * - an `ActivityEvent` for the activity timeline projection.
 *
 * No event is emitted when no lifecycle field changed.
 *
 * @returns `true` when an event was published, `false` for a no-op.
 */
export function publishStreamChange({
  before,
  after,
  action,
  actor,
  correlationId,
}: StreamChange): boolean {
  if (!hasLifecycleChange(before, after)) {
    return false;
  }

  const published = toPublishedStream(after);

  eventBus.emitStreamUpdated(after.id, published);

  if (action === "settle" && after.status === "ended" && before.status !== "ended") {
    eventBus.emitSettleFinished(after.id, published);
  }

  const activity: ActivityEvent & {
    actor?: string;
    correlationId?: string;
  } = {
    id: `activity-${randomUUID()}`,
    type: `stream.${action}`,
    streamId: after.id,
    timestamp: after.updatedAt ?? new Date().toISOString(),
    description: `Stream ${after.id} ${PAST_TENSE[action]}${
      actor ? ` by ${actor}` : ""
    }`,
    ...(actor ? { actor } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
  eventBus.emitActivityEvent(activity);

  return true;
}
