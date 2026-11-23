import { DEFAULT_QUIET_HOURS, type QuietHoursConfig } from "@/app/lib/quiet-hours";

export interface NotificationPreferences {
  userId: string;
  email: boolean;
  inApp: boolean;
  webhook: boolean;
  soundEnabled: boolean;
  events: {
    streamCreated: boolean;
    streamCompleted: boolean;
    streamCancelled: boolean;
    paymentFailed: boolean;
    lowBalance: boolean;
  };
  quietHours: QuietHoursConfig;
  updatedAt: string;
}

export type NotificationEventKey = keyof NotificationPreferences["events"];

export const DEFAULT_PREFS: Omit<NotificationPreferences, "userId" | "updatedAt"> = {
  email: true,
  inApp: true,
  webhook: false,
  soundEnabled: true,
  events: {
    streamCreated: true,
    streamCompleted: true,
    paymentFailed: true,
    streamCancelled: true,
    lowBalance: false,
  },
  quietHours: {
    ...DEFAULT_QUIET_HOURS,
  },
};

export const prefsStore = new Map<string, NotificationPreferences>();

export function getPreferences(userId: string): NotificationPreferences {
  const existing = prefsStore.get(userId);
  if (existing) {
    // Ensure quietHours is populated even if previously saved without it
    return {
      ...existing,
      quietHours: existing.quietHours ?? { ...DEFAULT_QUIET_HOURS },
    };
  }
  return {
    userId,
    ...DEFAULT_PREFS,
    events: { ...DEFAULT_PREFS.events },
    quietHours: { ...DEFAULT_QUIET_HOURS },
    updatedAt: new Date().toISOString(),
  };
}

export function setPreferences(userId: string, preferences: NotificationPreferences): void {
  prefsStore.set(userId, preferences);
}

export function resetPreferencesStore(): void {
  prefsStore.clear();
}
