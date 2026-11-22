import jwt from "jsonwebtoken";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  signToken,
} from "@/app/lib/auth";
import { getAdminAddress } from "@/app/lib/admin-guard";
import { resolveRequestActor, visibleTo } from "@/app/lib/stream-visibility";
import type { Stream } from "@/app/types/openapi";

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  allowActorHeader: process.env.STREAMPAY_ALLOW_ACTOR_HEADER,
};

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/streams", { headers });
}

function unsignedAdminToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      sub: "GFORGED",
      role: "admin",
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    }),
  ).toString("base64url");
  return `${header}.${claims}.`;
}

describe("resolveRequestActor", () => {
  beforeEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.STREAMPAY_ALLOW_ACTOR_HEADER;
  });

  afterEach(() => {
    if (originalEnv.nodeEnv === undefined) {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
    } else {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv.nodeEnv;
    }

    if (originalEnv.allowActorHeader === undefined) {
      delete process.env.STREAMPAY_ALLOW_ACTOR_HEADER;
    } else {
      process.env.STREAMPAY_ALLOW_ACTOR_HEADER = originalEnv.allowActorHeader;
    }
  });

  it("rejects forged tokens signed with the wrong key and unsigned alg=none tokens", () => {
    const wrongKeyToken = jwt.sign(
      {
        sub: "GFORGED",
        role: "admin",
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      },
      `${process.env.JWT_SECRET ?? "streampay-dev-secret-do-not-use-in-prod"}-wrong`,
      { algorithm: "HS256" },
    );

    for (const token of [wrongKeyToken, unsignedAdminToken()]) {
      expect(
        resolveRequestActor(requestWithHeaders({ authorization: `Bearer ${token}` })),
      ).toBeNull();
    }
  });

  it("rejects expired tokens", () => {
    const expiredToken = jwt.sign(
      { sub: "GEXPIRED", iss: JWT_ISSUER, aud: JWT_AUDIENCE },
      process.env.JWT_SECRET ?? "streampay-dev-secret-do-not-use-in-prod",
      { algorithm: "HS256", expiresIn: -1 },
    );

    expect(
      resolveRequestActor(requestWithHeaders({ authorization: `Bearer ${expiredToken}` })),
    ).toBeNull();
  });

  it.each(["x-streampay-actor-role", "x-actor-role"])(
    "does not let %s elevate a verified user token",
    (roleHeader) => {
      const actor = resolveRequestActor(
        requestWithHeaders({
          authorization: `Bearer ${signToken("GUSER")}`,
          [roleHeader]: "admin",
        }),
      );

      expect(actor).toEqual({
        actorId: "GUSER",
        walletAddress: "GUSER",
        role: "user",
        isAdmin: false,
      });
    },
  );

  it("resolves verified user and admin tokens with their verified roles", () => {
    expect(
      resolveRequestActor(
        requestWithHeaders({ authorization: `Bearer ${signToken("GUSER")}` }),
      ),
    ).toMatchObject({ role: "user", isAdmin: false });

    expect(
      resolveRequestActor(
        requestWithHeaders({
          authorization: `Bearer ${signToken("GADMIN", { role: "admin" })}`,
        }),
      ),
    ).toMatchObject({ role: "admin", isAdmin: true });

    expect(
      resolveRequestActor(
        requestWithHeaders({
          authorization: `Bearer ${signToken(getAdminAddress())}`,
        }),
      ),
    ).toMatchObject({ role: "admin", isAdmin: true });
  });

  it("does not fall back to enabled header identity when a Bearer token is invalid", () => {
    process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "true";

    expect(
      resolveRequestActor(
        requestWithHeaders({
          authorization: "Bearer invalid-token",
          "Actor-Wallet-Address": "GHEADER",
        }),
      ),
    ).toBeNull();
  });

  it("rejects header-only identity unless explicitly enabled outside production", () => {
    const request = requestWithHeaders({ "Actor-Wallet-Address": "GHEADER" });

    expect(resolveRequestActor(request)).toBeNull();

    process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "true";
    expect(resolveRequestActor(request)).toMatchObject({
      actorId: "GHEADER",
      walletAddress: "GHEADER",
      role: "user",
      isAdmin: false,
    });

    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(resolveRequestActor(request)).toBeNull();
  });

  it("never promotes the literal admin or configured admin address from headers", () => {
    process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "true";
    const privateStream = {
      id: "private-stream",
      tenantId: "tenant-a",
      senderAddress: "GSENDER",
      recipient: "GRECIPIENT",
    } as Stream;

    for (const wallet of ["admin", getAdminAddress()]) {
      const actor = resolveRequestActor(
        requestWithHeaders({ "Actor-Wallet-Address": wallet }),
      );

      expect(actor).toMatchObject({ role: "user", isAdmin: false });
      expect(visibleTo(actor, "tenant-a")(privateStream)).toBe(false);
    }
  });
});
