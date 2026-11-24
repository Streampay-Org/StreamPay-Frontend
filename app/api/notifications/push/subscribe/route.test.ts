/** @jest-environment node */

import { createECDH } from "node:crypto";
import { GET, POST, DELETE } from "./route";
import { signToken } from "@/app/lib/auth";
import { setPushSubscriptionStoreForTesting } from "@/app/lib/push-store";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

jest.mock("@/lib/routeSpan", () => ({
  withRouteSpan: (_name: string, handler: (request: Request) => Promise<Response>) =>
    (request: Request) => handler(request),
}));

jest.mock("@/app/lib/rate-limit-config", () => {
  const actual = jest.requireActual("@/app/lib/rate-limit-config");
  return { ...actual, getLimitForRoute: jest.fn(() => "read") };
});

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const PUBLIC_KEY = ecdh.getPublicKey().toString("base64url");
const PRIVATE_KEY = ecdh.getPrivateKey().toString("base64url");
const ENDPOINT = "https://push.example/subscription/1";

function setVapidConfig() {
  process.env.VAPID_PUBLIC_KEY = PUBLIC_KEY;
  process.env.VAPID_PRIVATE_KEY = PRIVATE_KEY;
  process.env.VAPID_SUBJECT = "mailto:push@example.com";
}

function authorization() {
  return `Bearer ${signToken("G-WALLET", { actorId: "wallet-user" })}`;
}

function postRequest({
  endpoint = ENDPOINT,
  auth = authorization(),
  keys = { p256dh: "p".repeat(32), auth: "a".repeat(24) },
}: {
  endpoint?: string;
  auth?: string;
  keys?: { p256dh: string; auth: string };
} = {}) {
  return new Request("http://localhost/api/notifications/push/subscribe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: auth,
    },
    body: JSON.stringify({ endpoint, keys }),
  });
}

function deleteRequest(endpoint = ENDPOINT, auth = authorization()) {
  return new Request("http://localhost/api/notifications/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ endpoint }),
  });
}

describe("/api/notifications/push/subscribe", () => {
  const oldEnvironment = {
    jwtSecret: process.env.JWT_SECRET,
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT,
  };

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
    setVapidConfig();
    setPushSubscriptionStoreForTesting(null);
    resetRateLimitStore();
  });

  afterEach(() => {
    if (oldEnvironment.jwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldEnvironment.jwtSecret;
    if (oldEnvironment.publicKey === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = oldEnvironment.publicKey;
    if (oldEnvironment.privateKey === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = oldEnvironment.privateKey;
    if (oldEnvironment.subject === undefined) delete process.env.VAPID_SUBJECT;
    else process.env.VAPID_SUBJECT = oldEnvironment.subject;
    setPushSubscriptionStoreForTesting(null);
    resetRateLimitStore();
  });

  it("returns only the configured public VAPID key", async () => {
    const response = await GET(new Request("http://localhost/api/notifications/push/subscribe"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: { publicKey: PUBLIC_KEY } });
    expect(JSON.stringify(body)).not.toContain(PRIVATE_KEY);
  });

  it("fails closed with 503 when VAPID configuration is missing", async () => {
    delete process.env.VAPID_PRIVATE_KEY;

    const response = await GET(new Request("http://localhost/api/notifications/push/subscribe"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "PUSH_DISABLED" },
    });
  });

  it("requires authentication and rejects non-HTTPS endpoints", async () => {
    const unauthorized = await POST(postRequest({ auth: "" }));
    const invalid = await POST(postRequest({ endpoint: "http://push.example/subscription" }));

    expect(unauthorized.status).toBe(401);
    expect(invalid.status).toBe(400);
  });

  it("stores duplicate endpoints idempotently without returning subscription secrets", async () => {
    const first = await POST(postRequest());
    const duplicate = await POST(postRequest());
    const body = await first.json();
    const duplicateBody = await duplicate.json();

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(body).toEqual({ data: { subscribed: true } });
    expect(JSON.stringify(body)).not.toContain(ENDPOINT);
    expect(JSON.stringify(body)).not.toContain("p".repeat(32));
    expect(duplicateBody).toEqual(body);
  });

  it("removes a subscription only for its authenticated owner", async () => {
    await POST(postRequest());
    const wrongOwnerToken = signToken("G-OTHER", { actorId: "other-user" });
    const wrongOwnerResponse = await DELETE(deleteRequest(ENDPOINT, `Bearer ${wrongOwnerToken}`));
    const ownerResponse = await DELETE(deleteRequest());

    expect(await wrongOwnerResponse.json()).toEqual({ data: { removed: false } });
    expect(await ownerResponse.json()).toEqual({ data: { removed: true } });
  });

  it("does not let another user claim an existing endpoint", async () => {
    await POST(postRequest());
    const otherUserToken = signToken("G-OTHER", { actorId: "other-user" });
    const response = await POST(postRequest({ auth: `Bearer ${otherUserToken}` }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "SUBSCRIPTION_ALREADY_REGISTERED" },
    });
  });

  it("enforces the configured per-user subscription maximum", async () => {
    const responses = await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        POST(postRequest({ endpoint: `https://push.example/subscription/${index}` })),
      ),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses[10].status).toBe(409);
  });
});
