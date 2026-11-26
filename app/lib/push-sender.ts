import { sendNotification } from "web-push";
import { getPreferences } from "@/app/lib/notification-prefs-store";
import { shouldSuppressNotification } from "@/app/lib/quiet-hours";
import {
  getPushSubscriptionStore,
  type PushSubscriptionStore,
} from "@/app/lib/push-store";
import { getPushConfig } from "@/app/lib/push-config";
import type { NotificationEventKey } from "@/app/lib/notification-prefs-store";

export interface PushMessage {
  eventType: NotificationEventKey;
  title: string;
  message: string;
  streamId?: string;
}

export interface SendPushResult {
  sent: number;
  removed: number;
  skipped: boolean;
}

export interface SendPushOptions {
  store?: PushSubscriptionStore;
  clock?: () => Date;
}

export class PushUnavailableError extends Error {
  constructor() {
    super("Web Push is not configured.");
    this.name = "PushUnavailableError";
  }
}

export class PushDeliveryError extends Error {
  constructor(readonly failedCount: number) {
    super(`Unable to deliver to ${failedCount} push subscription(s).`);
    this.name = "PushDeliveryError";
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

export async function sendPush(
  userId: string,
  payload: PushMessage,
  options: SendPushOptions = {},
): Promise<SendPushResult> {
  const config = getPushConfig();
  if (!config) throw new PushUnavailableError();

  const store = options.store ?? getPushSubscriptionStore();
  const now = options.clock?.() ?? new Date();
  const preferences = getPreferences(userId);
  const suppression = shouldSuppressNotification(
    preferences.quietHours,
    payload.eventType,
    now,
  );
  if (suppression.suppress) {
    return { sent: 0, removed: 0, skipped: true };
  }

  const subscriptions = store.listForUser(userId);
  let sent = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          },
          JSON.stringify({
            title: payload.title,
            body: payload.message,
            ...(payload.streamId ? { streamId: payload.streamId } : {}),
          }),
          {
            TTL: 3_600,
            vapidDetails: {
              subject: config.subject,
              publicKey: config.publicKey,
              privateKey: config.privateKey,
            },
          },
        );
        sent += 1;
      } catch (error) {
        const statusCode = getStatusCode(error);
        if (statusCode === 404 || statusCode === 410) {
          if (store.remove(userId, subscription.endpoint)) removed += 1;
        } else {
          failed += 1;
        }
      }
    }),
  );

  if (failed > 0) throw new PushDeliveryError(failed);
  return { sent, removed, skipped: false };
}
