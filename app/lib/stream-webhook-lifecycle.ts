import { logger } from "./logger";
import { webhookOutboxStore } from "./webhook-outbox";
import { toWebhookEvent } from "./webhook-events";

export type StreamLifecycleWebhookAction =
  | "start"
  | "resume"
  | "pause"
  | "stop"
  | "settle"
  | "cancel"
  | "withdraw";

export interface StreamLifecycleWebhookInput {
  action: StreamLifecycleWebhookAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Enqueue the lifecycle webhook for `POST /api/streams/:id/stop`.
 *
 * The route only passes the before/after snapshots, so the stream id and
 * `webhook_url` are read from `after`. Must be called after the store write
 * has committed; the deterministic event id keeps retries idempotent.
 */
export function enqueueStreamLifecycleWebhook(
  input: StreamLifecycleWebhookInput,
): void {
  const after = input.after;
  if (!after) return;

  const streamId = typeof after.id === "string" ? after.id : null;
  const webhookUrl =
    typeof after.webhook_url === "string" ? after.webhook_url : null;
  const updatedAt =
    typeof after.updatedAt === "string"
      ? after.updatedAt
      : new Date().toISOString();

  if (!streamId || !webhookUrl) return;

  const event = toWebhookEvent(
    input.before as never,
    after as never,
    input.action,
  );
  if (!event) return;

  try {
    webhookOutboxStore.enqueueStreamLifecycleEvent(
      { id: streamId, webhook_url: webhookUrl } as never,
      event.type as never,
      event.data,
      updatedAt,
    );
  } catch (error) {
    // A webhook enqueue must never fail the state transition.
    logger.warn("Failed to enqueue stream lifecycle webhook", {
      error,
      streamId,
      action: input.action,
    });
  }
}
