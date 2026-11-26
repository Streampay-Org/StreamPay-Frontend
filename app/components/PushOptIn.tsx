"use client";

import { useEffect, useMemo, useState } from "react";

type PushOptInProps = {
  emailFallbackEnabled: boolean;
  onEmailFallbackChange: (nextValue: boolean) => void;
};

type PushAvailability =
  | "checking"
  | "supported"
  | "unsupported"
  | "denied"
  | "enabled";

const SUBSCRIPTION_URL = "/api/notifications/push/subscribe";

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;

  for (const cookieName of ["__Host-csrf-token", "csrf-token"]) {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`),
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function detectAvailability(): PushAvailability {
  if (typeof window === "undefined") return "checking";
  if (!window.isSecureContext) return "unsupported";
  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    return "unsupported";
  }
  if (Notification.permission === "granted") return "enabled";
  if (Notification.permission === "denied") return "denied";
  return "supported";
}

function decodeVapidPublicKey(publicKey: string): ArrayBuffer {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const decoded = window.atob(padded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

async function requireSuccess(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${action} failed (HTTP ${response.status}).`);
  }
}

export function PushOptIn({
  emailFallbackEnabled,
  onEmailFallbackChange,
}: PushOptInProps) {
  const [availability, setAvailability] = useState<PushAvailability>("checking");
  const [isRequesting, setIsRequesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAvailability(detectAvailability());
  }, []);

  const details = useMemo(() => {
    switch (availability) {
      case "enabled":
        return {
          tone: "success",
          title: "Push notifications are on",
          description:
            "StreamPay updates can reach this browser instantly when stream activity changes.",
          cta: null,
        };
      case "denied":
        return {
          tone: "warning",
          title: "Push access is blocked in this browser",
          description:
            "We cannot send web push here, so email fallback becomes the safe default for critical alerts.",
          cta: null,
        };
      case "unsupported":
        return {
          tone: "info",
          title: "Web push is unavailable on this device",
          description:
            "Push needs a secure, supported browser context. Email fallback keeps essential notifications flowing.",
          cta: null,
        };
      case "supported":
        return {
          tone: "info",
          title: "Enable browser push for instant alerts",
          description:
            "We only prompt in supported secure contexts. If you skip or deny it, email can handle critical updates instead.",
          cta: "Enable push notifications",
        };
      default:
        return {
          tone: "info",
          title: "Checking push support",
          description: "Reviewing browser support before we offer web push.",
          cta: null,
        };
    }
  }, [availability]);

  const requestPermission = async () => {
    if (availability !== "supported") return;

    setIsRequesting(true);
    setMessage(null);

    try {
      const permission = await Notification.requestPermission();

      if (permission === "granted") {
        const keyResponse = await fetch(SUBSCRIPTION_URL, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        await requireSuccess(keyResponse, "Push configuration request");
        const keyBody = (await keyResponse.json()) as {
          data?: { publicKey?: unknown };
        };
        if (typeof keyBody.data?.publicKey !== "string") {
          throw new Error("The server returned an invalid VAPID public key.");
        }

        const registration = await navigator.serviceWorker.register("/sw.js");
        let subscription = await registration.pushManager.getSubscription();
        let createdSubscription = false;
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeVapidPublicKey(keyBody.data.publicKey),
          });
          createdSubscription = true;
        }

        const csrfToken = readCsrfToken();
        const subscribeResponse = await fetch(SUBSCRIPTION_URL, {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify(subscription.toJSON()),
        });
        if (!subscribeResponse.ok) {
          if (createdSubscription) await subscription.unsubscribe();
          await requireSuccess(subscribeResponse, "Push subscription");
        }

        setAvailability("enabled");
        setMessage("Push notifications enabled for this browser.");
        return;
      }

      if (permission === "denied") {
        setAvailability("denied");
        onEmailFallbackChange(true);
        setMessage("Push was denied, so email fallback has been enabled.");
        return;
      }

      setMessage("Push setup was skipped. You can keep email fallback on for critical alerts.");
    } catch (error) {
      setAvailability("supported");
      onEmailFallbackChange(true);
      const reason = error instanceof Error ? error.message : "The browser or server rejected setup.";
      setMessage(`Push setup failed: ${reason} Email fallback has been enabled.`);
    } finally {
      setIsRequesting(false);
    }
  };

  const turnOffPush = async () => {
    setIsRequesting(true);
    setMessage(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = registration
        ? await registration.pushManager.getSubscription()
        : null;

      if (subscription) {
        const csrfToken = readCsrfToken();
        const response = await fetch(SUBSCRIPTION_URL, {
          method: "DELETE",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
          },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await requireSuccess(response, "Push unsubscribe request");
        await subscription.unsubscribe();
      }

      setAvailability("supported");
      setMessage("Push notifications turned off for this browser.");
    } catch (error) {
      onEmailFallbackChange(true);
      const reason = error instanceof Error ? error.message : "The browser or server rejected the request.";
      setMessage(`Could not turn off push notifications: ${reason} Email fallback has been enabled.`);
    } finally {
      setIsRequesting(false);
    }
  };

  const showFallback = availability === "unsupported" || availability === "denied" || availability === "supported";

  return (
    <section
      aria-labelledby="push-opt-in-title"
      className={`push-optin push-optin--${details.tone}`}
    >
      <div className="push-optin__copy">
        <p className="push-optin__eyebrow">Instant alerts</p>
        <h2 className="push-optin__title" id="push-opt-in-title">
          {details.title}
        </h2>
        <p className="push-optin__description">{details.description}</p>
        <p className="push-optin__security-note">
          Push prompts are only available in secure browser contexts and never triggered automatically on page load.
        </p>
      </div>

      <div className="push-optin__actions">
        {details.cta && (
          <button
            className="button button--primary"
            disabled={isRequesting}
            onClick={requestPermission}
            type="button"
          >
            {isRequesting ? "Requesting permission..." : details.cta}
          </button>
        )}

        {availability === "enabled" && (
          <button
            className="button button--secondary"
            disabled={isRequesting}
            onClick={turnOffPush}
            type="button"
          >
            {isRequesting ? "Turning off push..." : "Turn off push notifications"}
          </button>
        )}

        {showFallback && (
          <label className="push-optin__fallback">
            <input
              checked={emailFallbackEnabled}
              onChange={(event) => onEmailFallbackChange(event.target.checked)}
              type="checkbox"
            />
            <span>Email me critical alerts if push is unavailable</span>
          </label>
        )}

        {message && (
          <p className="push-optin__message" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
