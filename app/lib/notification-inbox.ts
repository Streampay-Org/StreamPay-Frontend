import type { NotificationChannel, NotificationPayload } from "@/app/lib/notification-dispatcher";
import type { NotificationEventKey } from "@/app/lib/notification-prefs-store";

export interface InboxNotification {
  id: string;
  eventId: string;
  userId: string;
  eventType: NotificationEventKey;
  activityType: string;
  streamId?: string;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationInbox {
  add(notification: InboxNotification): void;
  listForUser(userId: string): InboxNotification[];
  markAsRead(userId: string, notificationId: string): boolean;
  clear(): void;
  size(): number;
}

export function createNotificationInbox(): NotificationInbox {
  const byUser = new Map<string, InboxNotification[]>();

  return {
    add(notification: InboxNotification) {
      const existing = byUser.get(notification.userId) ?? [];
      existing.push(notification);
      byUser.set(notification.userId, existing);
    },

    listForUser(userId: string): InboxNotification[] {
      return [...(byUser.get(userId) ?? [])];
    },

    markAsRead(userId: string, notificationId: string): boolean {
      const list = byUser.get(userId);
      if (!list) return false;
      const item = list.find((entry) => entry.id === notificationId);
      if (!item) return false;
      item.read = true;
      return true;
    },

    clear() {
      byUser.clear();
    },

    size(): number {
      let total = 0;
      for (const list of byUser.values()) {
        total += list.length;
      }
      return total;
    },
  };
}

export const notificationInbox = createNotificationInbox();

export function createInAppNotificationChannel(
  inbox: NotificationInbox = notificationInbox,
): NotificationChannel {
  return {
    name: "inApp",
    send(notification: NotificationPayload): void {
      inbox.add({
        id: notification.id,
        eventId: notification.eventId,
        userId: notification.userId,
        eventType: notification.eventType,
        activityType: notification.activityType,
        ...(notification.streamId ? { streamId: notification.streamId } : {}),
        title: notification.title,
        message: notification.message,
        createdAt: notification.timestamp,
        read: false,
      });
    },
  };
}

export const inAppNotificationChannel = createInAppNotificationChannel(notificationInbox);
