import type { Stream } from "@/app/types/openapi";
import {
  toWebhookEvent as toLifecycleEventType,
  type StreamLifecycleAction,
} from "./webhook-outbox";

/**
 * Map a committed stream transition to its lifecycle event type.
 *
 * The cancel/settle routes only need the string type; an empty string means
 * the transition does not emit a webhook.
 */
export function toWebhookEvent(
  before: Pick<Stream, "status"> | null,
  after: Pick<Stream, "status">,
  action: StreamLifecycleAction,
): string {
  return toLifecycleEventType(before, after, action) ?? "";
}

export interface StreamWebhookPayloadInput {
  eventType: string;
  streamId: string;
  action: StreamLifecycleAction;
  before: Pick<Stream, "status"> | null;
  after: Pick<Stream, "status">;
  occurredAt: string;
}

/** Flat payload stored on the outbox entry for a stream lifecycle event. */
export function buildStreamWebhookPayload(
  input: StreamWebhookPayloadInput,
): Record<string, unknown> {
  return {
    stream_id: input.streamId,
    event_type: input.eventType,
    action: input.action,
    previous_status: input.before?.status ?? null,
    status: input.after.status,
    occurred_at: input.occurredAt,
  };
}
