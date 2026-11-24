/** @jest-environment node */

import { getStore, resetStore } from "@/app/lib/db";
import { eventBus } from "@/app/lib/event-bus";
import { logger } from "@/app/lib/logger";
import {
  createNotificationDispatcher,
  startNotificationDispatcher,
  stopNotificationDispatcher,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationScheduler,
} from "@/app/lib/notification-dispatcher";
import {
  createEmailNotificationChannel,
  type EmailMessage,
} from "@/app/lib/notification-email";
import {
  createInAppNotificationChannel,
  createNotificationInbox,
} from "@/app/lib/notification-inbox";
import {
  DEFAULT_PREFS,
  getPreferences,
  resetPreferencesStore,
  setPreferences,
  type NotificationPreferences,
} from "@/app/lib/notification-prefs-store";
import type { ActivityEvent, Stream } from "@/app/types/openapi";

interface ScheduledJob {
  runAt: Date;
  callback: () => void | Promise<void>;
  cancelled: boolean;
}

function createFakeScheduler() {
  const jobs: ScheduledJob[] = [];

  const scheduler: NotificationScheduler = {
    schedule(runAt: Date, callback: () => void | Promise<void>) {
      const job: ScheduledJob = { runAt, callback, cancelled: false };
      jobs.push(job);
      return () => {
        job.cancelled = true;
      };
    },
  };

  async function flushAll() {
    for (const job of jobs) {
      if (!job.cancelled) {
        await job.callback();
      }
    }
  }

  return { scheduler, jobs, flushAll };
}

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-1",
    senderAddress: "GSENDER111",
    recipient: "GRECIPIENT222",
    rate: "100",
    schedule: "monthly",
    status: "active",
    token: "XLM",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "evt-1",
    type: "stream.created",
    streamId: "stream-1",
    timestamp: "2026-06-01T12:00:00.000Z",
    description: "Stream stream-1 created",
    ...overrides,
  };
}

function saveUserPrefs(
  userId: string,
  overrides: Partial<Omit<NotificationPreferences, "userId" | "events" | "quietHours">> & {
    events?: Partial<NotificationPreferences["events"]>;
    quietHours?: Partial<NotificationPreferences["quietHours"]>;
  } = {},
) {
  setPreferences(userId, {
    userId,
    ...DEFAULT_PREFS,
    ...overrides,
    events: {
      ...DEFAULT_PREFS.events,
      ...(overrides.events ?? {}),
    },
    quietHours: {
      ...DEFAULT_PREFS.quietHours,
      ...(overrides.quietHours ?? {}),
    },
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
}

describe("notification-dispatcher", () => {
  beforeEach(() => {
    resetStore();
    resetPreferencesStore();
    stopNotificationDispatcher();
    jest.spyOn(logger, "error").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    stopNotificationDispatcher();
    jest.restoreAllMocks();
  });

  it("delivers exactly one inbox notification when inApp is enabled, event toggle is on, and outside quiet hours", async () => {
    const inbox = createNotificationInbox();
    const sentEmails: EmailMessage[] = [];
    const { scheduler } = createFakeScheduler();

    getStore().streamRepository.streams.set("stream-1", makeStream());
    saveUserPrefs("GRECIPIENT222", { inApp: true, email: false });
    saveUserPrefs("GSENDER111", { inApp: false, email: false });

    const dispatcher = createNotificationDispatcher({
      prefs: getPreferences,
      channels: [
        createInAppNotificationChannel(inbox),
        createEmailNotificationChannel({
          sendEmail: (msg) => {
            sentEmails.push(msg);
          },
        }),
      ],
      clock: () => new Date("2026-06-01T12:00:00.000Z"),
      scheduler,
    });

    await dispatcher.dispatch(makeEvent());

    const notifications = inbox.listForUser("GRECIPIENT222");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      eventId: "evt-1",
      userId: "GRECIPIENT222",
      eventType: "streamCreated",
      activityType: "stream.created",
      streamId: "stream-1",
      read: false,
    });
    expect(sentEmails).toHaveLength(0);
  });

  it("defers non-critical events inside quiet hours until the window end and delivers critical events immediately", async () => {
    const inbox = createNotificationInbox();
    const { scheduler, jobs, flushAll } = createFakeScheduler();

    getStore().streamRepository.streams.set(
      "stream-1",
      makeStream({ senderAddress: "GUSER1", recipient: "GUSER1" }),
    );
    saveUserPrefs("GUSER1", {
      inApp: true,
      email: false,
      quietHours: {
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        allowCriticalAlerts: true,
      },
    });

    const dispatcher = createNotificationDispatcher({
      prefs: getPreferences,
      channels: [createInAppNotificationChannel(inbox)],
      // 23:00 UTC is inside 22:00-08:00 UTC quiet hours
      clock: () => new Date("2026-06-01T23:00:00.000Z"),
      scheduler,
    });

    // Non-critical event: deferred
    await dispatcher.dispatch(makeEvent({ id: "evt-non-critical", type: "stream.created" }));
    expect(inbox.listForUser("GUSER1")).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].runAt.toISOString()).toBe("2026-06-02T08:00:00.000Z");

    // Critical event: delivered immediately
    await dispatcher.dispatch(
      makeEvent({
        id: "evt-critical",
        type: "payment.failed",
        description: "Payment failed for stream-1",
      }),
    );
    expect(inbox.listForUser("GUSER1")).toHaveLength(1);
    expect(inbox.listForUser("GUSER1")[0].eventId).toBe("evt-critical");

    // Flush scheduled jobs (quiet hours end)
    await flushAll();
    expect(inbox.listForUser("GUSER1")).toHaveLength(2);
    expect(inbox.listForUser("GUSER1")[1].eventId).toBe("evt-non-critical");
  });

  it("produces nothing when event toggle or channels are turned off, and isolates failing channels", async () => {
    const delivered: NotificationPayload[] = [];
    const { scheduler } = createFakeScheduler();

    const failingEmailChannel: NotificationChannel = {
      name: "email",
      send() {
        throw new Error("SMTP down");
      },
    };
    const workingInAppChannel: NotificationChannel = {
      name: "inApp",
      send(payload) {
        delivered.push(payload);
      },
    };

    getStore().streamRepository.streams.set(
      "stream-1",
      makeStream({ senderAddress: "GUSER_OFF", recipient: "GUSER_ON" }),
    );
    saveUserPrefs("GUSER_OFF", {
      inApp: true,
      email: true,
      events: { streamCreated: false },
    });
    saveUserPrefs("GUSER_ON", {
      inApp: true,
      email: true,
      events: { streamCreated: true },
    });

    const dispatcher = createNotificationDispatcher({
      prefs: getPreferences,
      channels: [failingEmailChannel, workingInAppChannel],
      clock: () => new Date("2026-06-01T12:00:00.000Z"),
      scheduler,
    });

    await dispatcher.dispatch(makeEvent());

    expect(delivered).toHaveLength(1);
    expect(delivered[0].userId).toBe("GUSER_ON");
    expect(logger.error).toHaveBeenCalledWith(
      "Notification channel delivery failed",
      expect.objectContaining({
        channel: "email",
        userId: "GUSER_ON",
        error: "SMTP down",
      }),
    );
  });

  it("deduplicates repeated emissions of the same event id", async () => {
    const inbox = createNotificationInbox();
    const { scheduler } = createFakeScheduler();

    getStore().streamRepository.streams.set(
      "stream-1",
      makeStream({ senderAddress: "GUSER1", recipient: "GUSER1" }),
    );
    saveUserPrefs("GUSER1", { inApp: true, email: false });

    const dispatcher = createNotificationDispatcher({
      prefs: getPreferences,
      channels: [createInAppNotificationChannel(inbox)],
      clock: () => new Date("2026-06-01T12:00:00.000Z"),
      scheduler,
    });

    const event = makeEvent({ id: "evt-dup" });
    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);

    expect(inbox.listForUser("GUSER1")).toHaveLength(1);
  });

  it("ignores unmapped activity event types", async () => {
    const inbox = createNotificationInbox();
    const { scheduler } = createFakeScheduler();

    getStore().streamRepository.streams.set("stream-1", makeStream());

    const dispatcher = createNotificationDispatcher({
      prefs: getPreferences,
      channels: [createInAppNotificationChannel(inbox)],
      clock: () => new Date("2026-06-01T12:00:00.000Z"),
      scheduler,
    });

    await dispatcher.dispatch(makeEvent({ id: "evt-unmapped", type: "wallet.connected" }));
    expect(inbox.size()).toBe(0);
  });

  describe("edge cases", () => {
    it("uses default preferences for a user without stored prefs", async () => {
      const inbox = createNotificationInbox();
      const sentEmails: EmailMessage[] = [];
      const { scheduler } = createFakeScheduler();

      getStore().streamRepository.streams.set(
        "stream-1",
        makeStream({ senderAddress: "GNEWUSER", recipient: "GNEWUSER" }),
      );

      const dispatcher = createNotificationDispatcher({
        prefs: getPreferences,
        channels: [
          createInAppNotificationChannel(inbox),
          createEmailNotificationChannel({
            sendEmail: (msg) => {
              sentEmails.push(msg);
            },
          }),
        ],
        clock: () => new Date("2026-06-01T12:00:00.000Z"),
        scheduler,
      });

      // streamCreated is true by default; lowBalance is false by default
      await dispatcher.dispatch(makeEvent({ id: "evt-default-on", type: "stream.created" }));
      await dispatcher.dispatch(makeEvent({ id: "evt-default-off", type: "balance.low" }));

      expect(inbox.listForUser("GNEWUSER")).toHaveLength(1);
      expect(sentEmails).toHaveLength(1);
    });

    it("handles DST boundary in quiet hours timezone (America/New_York spring forward)", async () => {
      const inbox = createNotificationInbox();
      const { scheduler, jobs } = createFakeScheduler();

      getStore().streamRepository.streams.set(
        "stream-1",
        makeStream({ senderAddress: "GDST", recipient: "GDST" }),
      );
      saveUserPrefs("GDST", {
        inApp: true,
        email: false,
        quietHours: {
          enabled: true,
          startTime: "22:00",
          endTime: "08:00",
          timezone: "America/New_York",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          allowCriticalAlerts: true,
        },
      });

      const dispatcher = createNotificationDispatcher({
        prefs: getPreferences,
        channels: [createInAppNotificationChannel(inbox)],
        // 2026-03-08T04:00:00Z is 2026-03-07 23:00 EST (night before spring-forward).
        // Quiet hours end at 2026-03-08 08:00 EDT = 2026-03-08T12:00:00.000Z.
        clock: () => new Date("2026-03-08T04:00:00.000Z"),
        scheduler,
      });

      await dispatcher.dispatch(makeEvent({ id: "evt-dst", type: "stream.created" }));

      expect(inbox.size()).toBe(0);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].runAt.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    });

    it("suppresses non-critical events without scheduling when quiet hours are always-on", async () => {
      const inbox = createNotificationInbox();
      const { scheduler, jobs } = createFakeScheduler();

      getStore().streamRepository.streams.set(
        "stream-1",
        makeStream({ senderAddress: "GALWAYS", recipient: "GALWAYS" }),
      );
      saveUserPrefs("GALWAYS", {
        inApp: true,
        email: false,
        quietHours: {
          enabled: true,
          startTime: "00:00",
          endTime: "00:00",
          timezone: "UTC",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          allowCriticalAlerts: true,
        },
      });

      const dispatcher = createNotificationDispatcher({
        prefs: getPreferences,
        channels: [createInAppNotificationChannel(inbox)],
        clock: () => new Date("2026-06-01T12:00:00.000Z"),
        scheduler,
      });

      await dispatcher.dispatch(makeEvent({ id: "evt-always-on", type: "stream.created" }));

      expect(inbox.size()).toBe(0);
      expect(jobs).toHaveLength(0);
    });

    it("notifies only once per channel when recipient equals sender", async () => {
      const inbox = createNotificationInbox();
      const { scheduler } = createFakeScheduler();

      getStore().streamRepository.streams.set(
        "stream-1",
        makeStream({ senderAddress: "GSAME", recipient: "GSAME" }),
      );
      saveUserPrefs("GSAME", { inApp: true, email: false });

      const dispatcher = createNotificationDispatcher({
        prefs: getPreferences,
        channels: [createInAppNotificationChannel(inbox)],
        clock: () => new Date("2026-06-01T12:00:00.000Z"),
        scheduler,
      });

      await dispatcher.dispatch(makeEvent({ id: "evt-self" }));

      expect(inbox.listForUser("GSAME")).toHaveLength(1);
    });
  });

  it("subscribes to eventBus on startNotificationDispatcher and unsubscribes on stopNotificationDispatcher", async () => {
    const inbox = createNotificationInbox();
    const { scheduler } = createFakeScheduler();

    getStore().streamRepository.streams.set(
      "stream-1",
      makeStream({ senderAddress: "GBUS", recipient: "GBUS" }),
    );
    saveUserPrefs("GBUS", { inApp: true, email: false });

    startNotificationDispatcher({
      prefs: getPreferences,
      channels: [createInAppNotificationChannel(inbox)],
      clock: () => new Date("2026-06-01T12:00:00.000Z"),
      scheduler,
    });

    eventBus.emitActivityEvent(makeEvent({ id: "evt-bus-1" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(inbox.listForUser("GBUS")).toHaveLength(1);

    stopNotificationDispatcher();

    eventBus.emitActivityEvent(makeEvent({ id: "evt-bus-2" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(inbox.listForUser("GBUS")).toHaveLength(1);
  });
});
