/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET } from "./route";

const TEST_JWT_SECRET = "test-secret-at-least-32-characters-long";
const DEV_JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

function requestWithAuth(authorization?: string) {
  return new Request("http://localhost/api/identity/me", {
    headers: authorization ? { authorization } : undefined,
  });
}

function signToken(payload: Record<string, unknown>, secret = TEST_JWT_SECRET, options: jwt.SignOptions = {}) {
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: "15m",
    ...options,
  });
}

function algNoneToken(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("GET /api/identity/me auth", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterAll(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it("rejects requests with no authorization header", async () => {
    const response = await GET(requestWithAuth());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects non-Bearer authorization headers", async () => {
    const response = await GET(requestWithAuth("Basic dXNlcjpwYXNz"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects expired Bearer tokens", async () => {
    const token = signToken({ sub: "GEXPIRED", actorId: "actor-expired" }, TEST_JWT_SECRET, {
      expiresIn: "-1s",
    });

    const response = await GET(requestWithAuth(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects Bearer tokens with a tampered signature", async () => {
    const token = signToken({ sub: "GTAMPERED", actorId: "actor-tampered" });
    const tamperedToken = `${token.slice(0, -1)}x`;

    const response = await GET(requestWithAuth(`Bearer ${tamperedToken}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects alg=none Bearer tokens", async () => {
    const token = algNoneToken({ sub: "GNONE", actorId: "actor-none" });

    const response = await GET(requestWithAuth(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects tokens signed with the insecure dev secret", async () => {
    const token = signToken({ sub: "GDEVSECRET", actorId: "actor-dev" }, DEV_JWT_SECRET);

    const response = await GET(requestWithAuth(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects valid-looking tokens when JWT_SECRET is missing", async () => {
    const token = signToken({ sub: "GMISSINGSECRET", actorId: "actor-missing" });
    delete process.env.JWT_SECRET;

    const response = await GET(requestWithAuth(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns wallet identity for a valid Bearer token", async () => {
    const token = signToken({ sub: "GVALIDWALLET", actorId: "actor-valid" });

    const response = await GET(requestWithAuth(`Bearer ${token}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.wallet_address).toBe("GVALIDWALLET");
    expect(body.data.display_name).toBe("GVALIDWALLET");
    expect(body.links.self).toBe("/api/identity/me");
  });
});
