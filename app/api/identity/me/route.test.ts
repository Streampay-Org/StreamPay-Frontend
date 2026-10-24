/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET } from "./route";
import { INSECURE_DEV_JWT_SECRET } from "@/app/lib/auth";
import { resetLastSeenStore, touchLastSeenFromRequest } from "@/lib/lastSeen";

const TEST_SECRET = "test-secret-at-least-32-characters-long";
const WALLET_ADDRESS = "GDUKMGUGDZQK6Y2VCXWQ3BWYQF6Q3EDL2CIMH6H3K7VKTDH6ZVSTREAM";

function requestWithAuthorization(authorization?: string) {
  const headers = new Headers();
  if (authorization) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/identity/me", { headers });
}

function signToken(payload: Record<string, unknown>, secret = TEST_SECRET) {
  return jwt.sign({ iss: "streampay", aud: "streampay-api", ...payload }, secret, { algorithm: "HS256", expiresIn: "15m" });
}

function unsignedToken(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("GET /api/identity/me", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_SECRET;
    resetLastSeenStore();
  });

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    jest.restoreAllMocks();
  });

  it("rejects a missing authorization header", async () => {
    const response = await GET(requestWithAuthorization());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("rejects a non-Bearer authorization header", async () => {
    const response = await GET(requestWithAuthorization("Basic abc123"));

    expect(response.status).toBe(401);
  });

  it("rejects an expired Bearer token", async () => {
    const token = jwt.sign({ sub: WALLET_ADDRESS }, TEST_SECRET, {
      algorithm: "HS256",
      expiresIn: "-1s",
    });

    const response = await GET(requestWithAuthorization(`Bearer ${token}`));

    expect(response.status).toBe(401);
  });

  it("rejects a Bearer token with a tampered signature", async () => {
    const token = signToken({ sub: WALLET_ADDRESS });
    const tamperedToken = `${token.slice(0, -1)}x`;

    const response = await GET(requestWithAuthorization(`Bearer ${tamperedToken}`));

    expect(response.status).toBe(401);
  });

  it("rejects an alg=none Bearer token", async () => {
    const token = unsignedToken({ sub: WALLET_ADDRESS });

    const response = await GET(requestWithAuthorization(`Bearer ${token}`));

    expect(response.status).toBe(401);
  });

  it("rejects tokens when JWT_SECRET is missing", async () => {
    delete process.env.JWT_SECRET;
    const token = signToken({ sub: WALLET_ADDRESS });

    const response = await GET(requestWithAuthorization(`Bearer ${token}`));

    expect(response.status).toBe(401);
  });

  it("rejects tokens signed with the insecure dev secret", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      process.env.JWT_SECRET = INSECURE_DEV_JWT_SECRET;
      const token = signToken({ sub: WALLET_ADDRESS }, INSECURE_DEV_JWT_SECRET);

      const response = await GET(requestWithAuthorization(`Bearer ${token}`));

      expect(response.status).toBe(401);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it("returns the actor identity for a valid Bearer token with created_at null", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-123", role: "user" });

    const response = await GET(requestWithAuthorization(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        wallet_address: WALLET_ADDRESS,
        display_name: WALLET_ADDRESS,
        created_at: null,
        last_seen: null,
      },
      links: { self: "/api/identity/me" },
    });
  });

  it("returns non-null last_seen when recorded via touchLastSeenFromRequest even if actorId differs from sub", async () => {
    const token = signToken({ sub: WALLET_ADDRESS, actorId: "actor-123", role: "user" });
    const request = requestWithAuthorization(`Bearer ${token}`);

    touchLastSeenFromRequest(request);

    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.created_at).toBeNull();
    expect(typeof body.data.last_seen).toBe("string");
    expect(body.data.last_seen).not.toBeNull();
  });
});
