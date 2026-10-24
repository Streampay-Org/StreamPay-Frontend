import crypto from "crypto";
import { logger, withWebhookContext, getCorrelationContext } from "./logger";
import {
  WebhookEndpoint,
  WebhookEvent,
} from "./webhook-delivery";
import type { Stream } from "./stream-store";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Lifecycle actions that can produce a stream webhook event.
 */
export type StreamLifecycleAction =
  | "create"
  | "pause"
  | "resume"
  | "stop"
  | "settle"
  | "cancel"
  | "withdraw";

/**
 * Allowed stream lifecycle webhook event types.
 */
export const STREAM_LIFECYCLE_EVENT_TYPES = [
  "stream.created",
  "stream.paused",
  "stream.resumed",
  "stream.stopped",
  "stream.settled",
  "stream.cancelled",
  "stream.withdrawn",
] as const;

export type StreamLifecycleEventType =
  (typeof STREAM_LIFECYCLE_EVENT_TYPES)[number];

/**
 * Map a stream transition (before/after/action) to a lifecycle webhook event
 * type. Returns `null` when the transition does not produce an event.
 */
export function toWebhookEvent(
  before: Pick<Stream, "status"> | null,
  after: Pick<Stream, "status">,
  action: StreamLifecycleAction,
): StreamLifecycleEventType | null {
  if (action === "create") return "stream.created";

  const previous = before?.status;
  const next = after.status;

  if (action === "pause" && previous === "active" && next === "paused") {
    return "stream.paused";
  }
  if (action === "resume" && previous === "paused" && next === "active") {
    return "stream.resumed";
  }
  if (action === "stop" && next === "ended") return "stream.stopped";
  if (action === "settle" && next === "ended") return "stream.settled";
  if (action === "cancel" && next === "cancelled") return "stream.cancelled";
  if (action === "withdraw" && next === "withdrawn") {
    return "stream.withdrawn";
  }

  return null;
}

export interface WebhookOutboxEntry {
  /** Unique outbox entry ID */
  id: string;
  /** The webhook endpoint to deliver to */
  endpoint: WebhookEndpoint;
  /** The webhook event payload */
  event: WebhookEvent;
  /** Status of the outbox entry */
  status: "pending" | "processing" | "delivered" | "failed" | "dlq";
  /** When the entry was created */
  createdAt: string;
  /** When the entry was last updated */
  updatedAt: string;
  /** Number of delivery attempts made */
  attempts: number;
  /** When to next attempt should be made (if applicable) */
  nextAttemptAt?: string;
  /** Error message if failed */
  lastError?: string;
};

// ── Outbox Store ─────────────────────────────────────────────────────────────────

/**
 * In-memory transactional outbox for webhook events.
 *
 * This stores events that need to be delivered as webhooks, ensuring
 * atomicity with the transaction that generated the event.
 */
export class WebhookOutboxStore {
  private entries: Map<string, WebhookOutboxEntry> = new Map();

  /**
   * Add a new event to the outbox (atomic operation with the transaction
   * that generated the event.
   */
  addToOutbox(
    endpoint: WebhookEndpoint,
    event: WebhookEvent,
  ): WebhookOutboxEntry {
    const id = `outbox-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const entry: WebhookOutboxEntry = {
      id,
      endpoint,
      event,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };

    this.entries.set(id, entry);

    const context = getCorrelationContext();
    logger.info("Webhook event added to outbox", {
      outbox_id: id,
      endpoint_id: endpoint.id,
      event_id: event.id,
      event_type: event.eventType,
      correlation_id: context?.correlation_id,
    });

    return entry;
  }

  /**
   * Enqueue a stream lifecycle webhook for the given stream, if the stream has
   * a `webhook_url` configured. Uses a deterministic event id so retries of the
   * same committed transition cannot double-enqueue.
   *
   * Must be called only after the stream write has committed.
   */
  enqueueStreamLifecycleEvent(
    stream: Stream,
    eventType: StreamLifecycleEventType,
    payload: Record<string, unknown>,
    updatedAt: string,
  ): WebhookOutboxEntry | null {
    if (!stream.webhook_url) return null;

    const eventId = `evt_${stream.id}_${eventType}_${updatedAt}`;
    const endpoint: WebhookEndpoint = {
      id: `stream:${stream.id}`,
      url: stream.webhook_url,
    };
    const event: WebhookEvent = {
      id: eventId,
      eventType,
      data: payload,
      createdAt: updatedAt,
    };
    return this.addToOutbox(endpoint, event);
  }

  /**
   * Get a single outbox entry by ID
   */
  getOutboxEntry(id: string): WebhookOutboxEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Find an outbox entry by its event id (used for idempotent enqueue checks).
   */
  getOutboxEntryByEventId(eventId: string): WebhookOutboxEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.event.id === eventId) return entry;
    }
    return undefined;
  }

  /**
   * Whether an outbox entry with the given event id already exists.
   */
  hasEventId(eventId: string): boolean {
    return this.getOutboxEntryByEventId(eventId) !== undefined;
  }

  /**
   * Get all outbox entries
   */
  getAllOutboxEntries(): WebhookOutboxEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get pending outbox entries ready for processing
   */
  getPendingOutboxEntries(limit: number = 100): WebhookOutboxEntry[] {
    const now = new Date();
    return Array.from(this.entries.values())
      .filter((entry) => {
        if (entry.status !== "pending" && entry.status !== "processing") return false;
        if (entry.nextAttemptAt && new Date(entry.nextAttemptAt) > now) return false;
        return true;
      })
      .slice(0, limit);
  }

  /**
   * Update an outbox entry's status
   */
  updateOutboxEntry(
    id: string,
    updates: Partial<Omit<WebhookOutboxEntry, "id" | "endpoint" | "event" | "createdAt">>,
  ): WebhookOutboxEntry | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;

    const updated: WebhookOutboxEntry = {
      ...entry,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(id, updated);

    logger.info("Webhook outbox entry updated", {
      outbox_id: id,
      status: updated.status,
      attempts: updated.attempts,
    });

    return updated;
  }

  /**
   * Idempotently enqueue a stream lifecycle event. If an entry with the same
   * deterministic event id already exists, returns the existing entry instead
   * of creating a duplicate.
   */
  enqueueStreamLifecycleEventIdempotent(
    stream: Stream,
    eventType: StreamLifecycleEventType,
    payload: Record<string, unknown>,
    updatedAt: string,
  ): WebhookOutboxEntry | null {
    if (!stream.webhook_url) return null;

    const eventId = `evt_${stream.id}_${eventType}_${updatedAt}`;
    const existing = this.getOutboxEntryByEventId(eventId);
    if (existing) return existing;

    return this.enqueueStreamLifecycleEvent(
      stream,
      eventType,
      payload,
      updatedAt,
    );
  }

  /**
   * Delete an outbox entry (for testing/cleanup)
   */
  deleteOutboxEntry(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Clear all outbox entries (for testing)
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Clear all outbox entries (alias retained for the legacy `lib/outbox.ts`
   * surface so existing callers keep working).
   */
  clearAll(): void {
    this.clear();
  }

  /**
   * Get outbox statistics
   */
  getStatistics() {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      pending: entries.filter((e) => e.status === "pending").length,
      processing: entries.filter((e) => e.status === "processing").length,
      delivered: entries.filter((e) => e.status === "delivered").length,
      failed: entries.filter((e) => e.status === "failed").length,
      dlq: entries.filter((e) => e.status === "dlq").length,
    };
  }
}

export const webhookOutboxStore = new WebhookOutboxStore();

export interface AddToOutboxParams {
  eventId: string;
  eventType?: string | null;
  streamId: string;
  url: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export function addToOutbox(params: AddToOutboxParams): WebhookOutboxEntry {
  const endpoint: WebhookEndpoint = {
    id: `stream:${params.streamId}`,
    url: params.url,
  };
  const event: WebhookEvent = {
    id: params.eventId,
    eventType: (params.eventType ?? "stream.updated") as any,
    data: params.payload ?? params.data ?? {},
    createdAt: new Date().toISOString(),
  };
  return webhookOutboxStore.addToOutbox(endpoint, event);
}

export function buildStreamWebhookPayload(params: {
  eventType?: string | null;
  streamId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt?: string;
}): Record<string, unknown> {
  return {
    event_type: params.eventType,
    stream_id: params.streamId,
    action: params.action,
    before: params.before,
    after: params.after,
    occurred_at: params.occurredAt ?? new Date().toISOString(),
  };
}

export function enqueueStreamLifecycleWebhook(params: {
  action: StreamLifecycleAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): void {
  const stream = params.after as unknown as Stream;
  if (!stream || !stream.webhook_url) return;
  const event = toWebhookEvent(
    params.before as unknown as Pick<Stream, "status"> | null,
    stream,
    params.action,
  );
  if (!event) return;
  const now = new Date().toISOString();
  addToOutbox({
    eventId: `evt_${stream.id}_${params.action}_${now}`,
    eventType: event,
    streamId: stream.id,
    url: stream.webhook_url,
    data: buildStreamWebhookPayload({
      eventType: event,
      streamId: stream.id,
      action: params.action,
      before: params.before,
      after: params.after,
      occurredAt: now,
    }),
  });
}

/**
 * Legacy alias kept so `lib/outbox.ts` can re-export a single outbox store
 * without introducing a second implementation.
 *
 * @deprecated Use `webhookOutboxStore` instead.
 */
export const InMemoryOutboxStore = WebhookOutboxStore;
export type InMemoryOutboxStore = WebhookOutboxStore;
