import type { WebhookPayload } from "@/src/validators/webhooks";

/**
 * Typed handler registry for inbound webhook events.
 *
 * Handlers are registered per `eventType` and invoked by `dispatchWebhook`.
 * Unknown event types return `{ handled: false }` without throwing.
 */

export type WebhookHandler = (payload: WebhookPayload) => Promise<void> | void;

export interface DispatchWebhookResult {
  handled: boolean;
  eventType: string;
}

export class WebhookHandlerRegistry {
  private readonly handlers = new Map<string, WebhookHandler>();

  register(eventType: string, handler: WebhookHandler): () => void {
    const normalized = eventType.trim();
    if (!normalized) {
      throw new Error("eventType must be a non-empty string");
    }
    this.handlers.set(normalized, handler);
    return () => {
      if (this.handlers.get(normalized) === handler) {
        this.handlers.delete(normalized);
      }
    };
  }

  unregister(eventType: string): boolean {
    return this.handlers.delete(eventType.trim());
  }

  has(eventType: string): boolean {
    return this.handlers.has(eventType.trim());
  }

  listEventTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  clear(): void {
    this.handlers.clear();
  }

  async dispatch(payload: WebhookPayload): Promise<DispatchWebhookResult> {
    const handler = this.handlers.get(payload.eventType);
    if (!handler) {
      return { handled: false, eventType: payload.eventType };
    }

    await handler(payload);
    return { handled: true, eventType: payload.eventType };
  }
}

export const webhookHandlerRegistry = new WebhookHandlerRegistry();

export function registerWebhookHandler(
  eventType: string,
  handler: WebhookHandler,
): () => void {
  return webhookHandlerRegistry.register(eventType, handler);
}

export function unregisterWebhookHandler(eventType: string): boolean {
  return webhookHandlerRegistry.unregister(eventType);
}

export function dispatchWebhook(
  payload: WebhookPayload,
): Promise<DispatchWebhookResult> {
  return webhookHandlerRegistry.dispatch(payload);
}

export function clearWebhookHandlers(): void {
  webhookHandlerRegistry.clear();
}
