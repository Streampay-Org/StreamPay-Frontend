import { createECDH } from "node:crypto";
import { sendNotification } from "web-push";
import {
  DEFAULT_PREFS,
  resetPreferencesStore,
  setPreferences,
} from "@/app/lib/notification-prefs-store";
import {
  InMemoryPushSubscriptionStore,
  type PushSubscriptionData,
} from "@/app/lib/push-store";
import { sendPush, PushUnavailableError } from "./push-sender";

jest.mock("web-push", () => ({
  sendNotification: jest.fn(),
}));

const mockedSendNotification = jest.mocked(sendNotification);
const USER_ID = "wallet-user";
const ENDPOINT = "https://push.example/subscription/1";
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID_PUBLIC_KEY = ecdh.getPublicKey().toString("base64url");
const VAPID_PRIVATE_KEY = ecdh.getPrivateKey().toString("base64url");

function subscription(endpoint = ENDPOINT): PushSubscriptionData {
  return { endpoint, keys: { p256dh: "p".repeat(32), auth: "a".repeat(24) } };
}

function setVapidConfig() {
  process.env.VAPID_PUBLIC_KEY = VAPID_PUBLIC_KEY;
  process.env.VAPID_PRIVATE_KEY = VAPID_PRIVATE_KEY;
  process.env.VAPID_SUBJECT = "mailto:push@example.com";
}

describe("sendPush", () => {
  const oldEnvironment = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };

  beforeEach(() => {
    setVapidConfig();
    resetPreferencesStore();
    mockedSendNotification.mockReset();
  });

  afterEach(() => {
    if (oldEnvironment.publicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = oldEnvironment.publicKey;
    if (oldEnvironment.privateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = oldEnvironment.privateKey;
    if (oldEnvironment.subject === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = oldEnvironment.subject;
    resetPreferencesStore();
  });

  it("does not send non-critical notifications during quiet hours", async () => {
    const store = new InMemoryPushSubscriptionStore();
    store.add(USER_ID, subscription(), 10);
    setPreferences(USER_ID, {
      userId: USER_ID,
      ...DEFAULT_PREFS,
      events: { ...DEFAULT_PREFS.events },
      quietHours: {
        enabled: true,
        startTime: "22:00",
        endTime: "08:00",
        timezone: "UTC",
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        allowCriticalAlerts: true,
      },
      updatedAt: "2026-06-15T00:00:00.000Z",
    });

    await expect(
      sendPush(
        USER_ID,
        { eventType: "streamCreated", title: "Started", message: "A stream started" },
        { store, clock: () => new Date("2026-06-15T23:00:00.000Z") },
      ),
    ).resolves.toEqual({ sent: 0, removed: 0, skipped: true });

    expect(mockedSendNotification).not.toHaveBeenCalled();
  });

  it("sends a push and supplies VAPID details without returning subscription data", async () => {
    const store = new InMemoryPushSubscriptionStore();
    store.add(USER_ID, subscription(), 10);
    mockedSendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    const result = await sendPush(USER_ID, {
      eventType: "streamCreated",
      title: "Started",
      message: "A stream started",
      streamId: "stream-1",
    }, { store, clock: () => new Date("2026-06-15T12:00:00.000Z") });

    expect(result).toEqual({ sent: 1, removed: 0, skipped: false });
    expect(mockedSendNotification).toHaveBeenCalledWith(
      { endpoint: ENDPOINT, keys: subscription().keys },
      JSON.stringify({ title: "Started", body: "A stream started", streamId: "stream-1" }),
      {
        TTL: 3_600,
        vapidDetails: {
          subject: "mailto:push@example.com",
          publicKey: VAPID_PUBLIC_KEY,
          privateKey: VAPID_PRIVATE_KEY,
        },
      },
    );
    expect(JSON.stringify(result)).not.toContain(ENDPOINT);
  });

  it("prunes subscriptions rejected with an expired 410 response", async () => {
    const store = new InMemoryPushSubscriptionStore();
    store.add(USER_ID, subscription(), 10);
    mockedSendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    const result = await sendPush(
      USER_ID,
      { eventType: "streamCreated", title: "Started", message: "A stream started" },
      { store, clock: () => new Date("2026-06-15T12:00:00.000Z") },
    );

    expect(result).toEqual({ sent: 0, removed: 1, skipped: false });
    expect(store.listForUser(USER_ID)).toEqual([]);
  });

  it("fails explicitly when VAPID configuration is unavailable", async () => {
    delete process.env.VAPID_PRIVATE_KEY;

    await expect(
      sendPush(USER_ID, {
        eventType: "streamCreated",
        title: "Started",
        message: "A stream started",
      }),
    ).rejects.toBeInstanceOf(PushUnavailableError);
  });
});
