/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { PushOptIn } from "./PushOptIn";

function setNotificationMock(
  permission: NotificationPermission,
  requestPermission: jest.Mock<Promise<NotificationPermission>, []>,
) {
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission, requestPermission },
  });
}

describe("PushOptIn", () => {
  const originalNotification = global.Notification;
  const originalPushManager = (window as typeof window & { PushManager?: unknown }).PushManager;
  const originalSecureContext = window.isSecureContext;
  const originalServiceWorker = navigator.serviceWorker;

  beforeEach(() => {
    document.cookie = "csrf-token=test-csrf-token; path=/";
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function PushManager() {},
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    document.cookie = "csrf-token=; Max-Age=0; path=/";
    global.Notification = originalNotification;
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: originalPushManager,
    });
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: originalSecureContext,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: originalServiceWorker,
    });
    jest.restoreAllMocks();
  });

  it("falls back to email when push is unsupported", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    const onEmailFallbackChange = jest.fn();
    render(
      React.createElement(PushOptIn, {
        emailFallbackEnabled: true,
        onEmailFallbackChange,
      })
    );

    expect(await screen.findByText(/web push is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable push notifications/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/email me critical alerts/i)).toBeChecked();
  });

  it("enables email fallback when the browser denies push permission", async () => {
    const requestPermission = jest.fn().mockResolvedValue("denied");
    setNotificationMock("default", requestPermission);

    const onEmailFallbackChange = jest.fn();
    render(
      React.createElement(PushOptIn, {
        emailFallbackEnabled: false,
        onEmailFallbackChange,
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: /enable push notifications/i }));

    await waitFor(() => {
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(onEmailFallbackChange).toHaveBeenCalledWith(true);
    });

    expect(screen.getByText(/email fallback has been enabled/i)).toBeInTheDocument();
  });

  it("registers the service worker and persists the browser subscription", async () => {
    const subscription = {
      endpoint: "https://push.example/subscription/1",
      toJSON: () => ({
        endpoint: "https://push.example/subscription/1",
        keys: { p256dh: "p".repeat(32), auth: "a".repeat(24) },
      }),
      unsubscribe: jest.fn().mockResolvedValue(true),
    };
    const subscribe = jest.fn().mockResolvedValue(subscription);
    const register = jest.fn().mockResolvedValue({
      pushManager: {
        getSubscription: jest.fn().mockResolvedValue(null),
        subscribe,
      },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    setNotificationMock("default", jest.fn().mockResolvedValue("granted"));

    const fetchMock = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { publicKey: "A".repeat(87) } }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    render(
      React.createElement(PushOptIn, {
        emailFallbackEnabled: false,
        onEmailFallbackChange: jest.fn(),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /enable push notifications/i }));

    expect(await screen.findByText(/push notifications enabled for this browser/i)).toBeInTheDocument();
    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(ArrayBuffer),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/notifications/push/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(subscription.toJSON()),
        headers: expect.objectContaining({ "x-csrf-token": "test-csrf-token" }),
      }),
    );
  });

  it("enables email fallback when the server cannot provide VAPID configuration", async () => {
    setNotificationMock("default", jest.fn().mockResolvedValue("granted"));
    jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    const onEmailFallbackChange = jest.fn();
    render(
      React.createElement(PushOptIn, {
        emailFallbackEnabled: false,
        onEmailFallbackChange,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /enable push notifications/i }));

    expect(await screen.findByText(/push setup failed.*email fallback has been enabled/i)).toBeInTheDocument();
    expect(onEmailFallbackChange).toHaveBeenCalledWith(true);
  });

  it("unsubscribes locally and removes the server subscription when turned off", async () => {
    setNotificationMock("granted", jest.fn());
    const unsubscribe = jest.fn().mockResolvedValue(true);
    const subscription = { endpoint: "https://push.example/subscription/1", unsubscribe };
    const getRegistration = jest.fn().mockResolvedValue({
      pushManager: { getSubscription: jest.fn().mockResolvedValue(subscription) },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration },
    });
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    render(
      React.createElement(PushOptIn, {
        emailFallbackEnabled: false,
        onEmailFallbackChange: jest.fn(),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: /turn off push notifications/i }));

    expect(await screen.findByText(/push notifications turned off for this browser/i)).toBeInTheDocument();
    expect(getRegistration).toHaveBeenCalledWith("/");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notifications/push/subscribe",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        headers: expect.objectContaining({ "x-csrf-token": "test-csrf-token" }),
      }),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
