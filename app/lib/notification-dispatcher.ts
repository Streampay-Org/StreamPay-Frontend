/**
 * Notification Dispatcher
 *
 * Consumes stream lifecycle `ActivityEvent`s from `eventBus`, resolves affected
 * recipients, applies per-user notification preferences and quiet-hours rules,
 * and delivers notifications through pluggable channel adapters (in-app, email).
 *
 * Startup wiring:
 *   This module deliberately does NOT auto-start on import. Call
 *   `startNotificationDispatcher()` during server bootstrap (for example in
 *   `instrumentation.ts` or your server entrypoint) and call
 *   `stopNotificationDispatcher()` during graceful shutdown or test teardown.
 */

import { getStore } from "@/app/lib/db";
import { eventBus } from "@/app/lib/event-bus";
import { logger } from "@/app/lib/logger";
import { emailNotificationChannel } from "@/app/lib/notification-email";
import { inAppNotificationChannel } from "@/app/lib/notification-inbox";
import {
  getPreferences,
  type NotificationEventKey,
  type NotificationPreferences,
} from "@/app/lib/notification-prefs-store";
import { shouldSuppressNotification } from "@/app/lib/quiet-hours";
import type { ActivityEvent } from "@/app/types/openapi";

export type NotificationChannelName = "inApp" | "email" | "webhook";

export interface NotificationPayload {
  id: string;
  eventId: string;
  userId: string;
  channel: NotificationChannelName;
  eventType: NotificationEventKey;
  activityType: string;
  streamId?: string;
  title: string;
  message: string;
  timestamp: string;
  scheduledFor?: string;
}

export interface NotificationChannel {
  readonly name: NotificationChannelName;
  send(notification: NotificationPayload): Promise<void> | void;
}

export interface NotificationScheduler {
  /**
   * Schedule `callback` to execute at `runAt`. Returns a cancel function.
   */
  schedule(runAt: Date, callback: () => void | Promise<void>): () => void;
}

export type PreferencesProvider =
  | ((userId: string) => NotificationPreferences)
  | { getPreferences(userId: string): NotificationPreferences };

export interface NotificationDispatcherOptions {
  prefs?: PreferencesProvider;
  channels?: NotificationChannel[];
  clock?: () => Date;
  scheduler?: NotificationScheduler;
  resolveRecipients?: (event: ActivityEvent) => string[];
}

export interface NotificationDispatcher {
  dispatch(event: ActivityEvent): Promise<void>;
  stop(): void;
  pendingCount(): number;
}

/**
 * Maps `ActivityEvent.type` values emitted by stream lifecycle handlers to
 * `NotificationPreferences["events"]` keys. Unmapped event types are ignored.
 */
export const ACTIVITY_TYPE_TO_PREFERENCE_KEY: Readonly<Record<string, NotificationEventKey>> = {
  "stream.created": "streamCreated",
  "stream.create": "streamCreated",
  "stream.start": "streamCreated",
  "stream.started": "streamCreated",
  stream_created: "streamCreated",
  streamCreated: "streamCreated",

  "stream.completed": "streamCompleted",
  "stream.complete": "streamCompleted",
  "stream.stop": "streamCompleted",
  "stream.stopped": "streamCompleted",
  "stream.settle": "streamCompleted",
  "stream.settled": "streamCompleted",
  "stream.ended": "streamCompleted",
  stream_completed: "streamCompleted",
  streamCompleted: "streamCompleted",

  "stream.cancelled": "streamCancelled",
  "stream.cancel": "streamCancelled",
  "stream.canceled": "streamCancelled",
  stream_cancelled: "streamCancelled",
  streamCancelled: "streamCancelled",

  "payment.failed": "paymentFailed",
  "settlement.failed": "paymentFailed",
  "withdrawal.failed": "paymentFailed",
  payment_failed: "paymentFailed",
  paymentFailed: "paymentFailed",

  "balance.low": "lowBalance",
  "funding.low": "lowBalance",
  low_balance: "lowBalance",
  lowBalance: "lowBalance",
};

const EVENT_TITLES: Record<NotificationEventKey, string> = {
  streamCreated: "Stream Created",
  streamCompleted: "Stream Completed",
  streamCancelled: "Stream Cancelled",
  paymentFailed: "Payment Failed",
  lowBalance: "Low Balance Alert",
};

export function mapActivityTypeToPreferenceKey(
  activityType: string,
): NotificationEventKey | undefined {
  return ACTIVITY_TYPE_TO_PREFERENCE_KEY[activityType];
}

export function createDefaultScheduler(clock: () => Date = () => new Date()): NotificationScheduler {
  return {
    schedule(runAt: Date, callback: () => void | Promise<void>): () => void {
      const delayMs = Math.max(0, runAt.getTime() - clock().getTime());
      const timer = setTimeout(() => {
        void callback();
      }, delayMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      return () => {
        clearTimeout(timer);
      };
    },
  };
}

function defaultResolveRecipients(event: ActivityEvent): string[] {
  const recipients = new Set<string>();

  if (event.streamId) {
    try {
      const store = getStore();
      const stream = store.streamRepository.streams.get(event.streamId);
      if (stream) {
        if (stream.senderAddress && stream.senderAddress.trim().length > 0) {
          recipients.add(stream.senderAddress.trim());
        }
        if (stream.recipient && stream.recipient.trim().length > 0) {
          recipients.add(stream.recipient.trim());
        }
      }
    } catch {
      // Persistence store unavailable; fall through to actorAddress fallback.
    }
  }

  if (recipients.size === 0 && event.actorAddress && event.actorAddress.trim().length > 0) {
    recipients.add(event.actorAddress.trim());
  }

  return Array.from(recipients);
}

function isChannelEnabledForUser(
  prefs: NotificationPreferences,
  channelName: NotificationChannelName,
): boolean {
  switch (channelName) {
    case "inApp":
      return prefs.inApp;
    case "email":
      return prefs.email;
    case "webhook":
      return prefs.webhook;
  }
}

export function createNotificationDispatcher(
  options: NotificationDispatcherOptions = {},
): NotificationDispatcher {
  const clock = options.clock ?? (() => new Date());
  const scheduler = options.scheduler ?? createDefaultScheduler(clock);
  const channels = options.channels ?? [inAppNotificationChannel, emailNotificationChannel];
  const resolveRecipients = options.resolveRecipients ?? defaultResolveRecipients;
  const lookupPrefs =
    typeof options.prefs === "function"
      ? options.prefs
      : options.prefs
        ? (userId: string) => options.prefs && "getPreferences" in options.prefs ? options.prefs.getPreferences(userId) : getPreferences(userId)
        : getPreferences;

  const seenDeliveries = new Set<string>();
  const pendingCancels = new Set<() => void>();

  async function deliverSingle(
    channel: NotificationChannel,
    payload: NotificationPayload,
  ): Promise<void> {
    try {
      await channel.send(payload);
    } catch (error) {
      logger.error("Notification channel delivery failed", {
        channel: channel.name,
        eventId: payload.eventId,
        userId: payload.userId,
        eventType: payload.eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function dispatch(event: ActivityEvent): Promise<void> {
    const preferenceKey = mapActivityTypeToPreferenceKey(event.type);
    if (!preferenceKey) {
      return;
    }

    const recipients = Array.from(
      new Set(resolveRecipients(event).filter((id) => typeof id === "string" && id.trim().length > 0)),
    );
    if (recipients.length === 0) {
      return;
    }

    const now = clock();

    for (const userId of recipients) {
      const userPrefs = lookupPrefs(userId);
      if (!userPrefs.events[preferenceKey]) {
        continue;
      }

      const enabledChannels = channels.filter((channel) =>
        isChannelEnabledForUser(userPrefs, channel.name),
      );
      if (enabledChannels.length === 0) {
        continue;
      }

      const decision = shouldSuppressNotification(userPrefs.quietHours, preferenceKey, now);

      if (decision.suppress && !decision.scheduledFor) {
        logger.info("Notification suppressed by always-on quiet hours", {
          eventId: event.id,
          userId,
          eventType: preferenceKey,
          reason: decision.reason,
        });
        continue;
      }

      const deliveries: Array<{ channel: NotificationChannel; payload: NotificationPayload }> = [];

      for (const channel of enabledChannels) {
        const dedupeKey = `${event.id}:${userId}:${channel.name}`;
        if (seenDeliveries.has(dedupeKey)) {
          continue;
        }
        seenDeliveries.add(dedupeKey);

        deliveries.push({
          channel,
          payload: {
            id: `${event.id}:${userId}:${channel.name}`,
            eventId: event.id,
            userId,
            channel: channel.name,
            eventType: preferenceKey,
            activityType: event.type,
            ...(event.streamId ? { streamId: event.streamId } : {}),
            title: EVENT_TITLES[preferenceKey],
            message: event.description,
            timestamp: event.timestamp || now.toISOString(),
            ...(decision.scheduledFor ? { scheduledFor: decision.scheduledFor.toISOString() } : {}),
          },
        });
      }

      if (deliveries.length === 0) {
        continue;
      }

      if (decision.suppress && decision.scheduledFor) {
        const scheduledFor = decision.scheduledFor;
        let cancel: () => void = () => {};
        cancel = scheduler.schedule(scheduledFor, async () => {
          pendingCancels.delete(cancel);
          await Promise.all(
            deliveries.map(({ channel, payload }) => deliverSingle(channel, payload)),
          );
        });
        pendingCancels.add(cancel);
      } else {
        await Promise.all(
          deliveries.map(({ channel, payload }) => deliverSingle(channel, payload)),
        );
      }
    }
  }

  function stop(): void {
    for (const cancel of pendingCancels) {
      cancel();
    }
    pendingCancels.clear();
  }

  function pendingCount(): number {
    return pendingCancels.size;
  }

  return {
    dispatch,
    stop,
    pendingCount,
  };
}

let activeDispatcher: NotificationDispatcher | null = null;
let activeHandler: ((event: ActivityEvent) => void) | null = null;

/**
 * Subscribe a notification dispatcher to `eventBus` activity events.
 * Calling this when already started stops the previous subscription first.
 */
export function startNotificationDispatcher(
  options?: NotificationDispatcherOptions,
): NotificationDispatcher {
  if (activeDispatcher) {
    stopNotificationDispatcher();
  }

  const dispatcher = createNotificationDispatcher(options);
  const handler = (event: ActivityEvent) => {
    void dispatcher.dispatch(event);
  };

  eventBus.onActivityEvent(handler);
  activeDispatcher = dispatcher;
  activeHandler = handler;

  return dispatcher;
}

/**
 * Unsubscribe the active notification dispatcher from `eventBus` and cancel
 * any pending deferred notifications.
 */
export function stopNotificationDispatcher(): void {
  if (activeHandler) {
    eventBus.off("activity:new", activeHandler);
    activeHandler = null;
  }
  if (activeDispatcher) {
    activeDispatcher.stop();
    activeDispatcher = null;
  }
}
