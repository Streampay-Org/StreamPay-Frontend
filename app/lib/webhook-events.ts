import type { Stream } from "@/app/types/openapi";
import {
  toWebhookEvent as toLifecycleEventType,
  type StreamLifecycleAction,
} from "./webhook-outbox";

export interface StreamWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Map a committed stream transition to the webhook event the pause/start
 * routes put in the outbox. Returns `null` for transitions without an event.
 */
export function toWebhookEvent(
  before: Pick<Stream, "status"> | null,
  after: Pick<Stream, "status">,
  action: StreamLifecycleAction,
): StreamWebhookEvent | null {
  const type = toLifecycleEventType(before, after, action);
  if (!type) return null;

  return {
    type,
    data: {
      previous_status: before?.status ?? null,
      status: after.status,
      action,
    },
  };
}
