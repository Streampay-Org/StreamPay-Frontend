import { logger } from "@/app/lib/logger";
import type { NotificationChannel, NotificationPayload } from "@/app/lib/notification-dispatcher";
import type { NotificationEventKey } from "@/app/lib/notification-prefs-store";

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  eventId: string;
  eventType: NotificationEventKey;
  streamId?: string;
}

export interface EmailTransport {
  sendEmail(message: EmailMessage): Promise<void> | void;
}

/**
 * Default no-op/console email transport.
 * Logs delivery intent via the structured logger without performing SMTP I/O.
 */
export function createNoopEmailTransport(): EmailTransport {
  return {
    sendEmail(message: EmailMessage): void {
      logger.info("Email notification dispatched (noop transport)", {
        to: message.to,
        subject: message.subject,
        eventId: message.eventId,
        eventType: message.eventType,
        streamId: message.streamId,
      });
    },
  };
}

export function createEmailNotificationChannel(
  transport: EmailTransport = createNoopEmailTransport(),
): NotificationChannel {
  return {
    name: "email",
    async send(notification: NotificationPayload): Promise<void> {
      await transport.sendEmail({
        to: notification.userId,
        subject: notification.title,
        body: notification.message,
        eventId: notification.eventId,
        eventType: notification.eventType,
        ...(notification.streamId ? { streamId: notification.streamId } : {}),
      });
    },
  };
}

export const emailNotificationChannel = createEmailNotificationChannel();
