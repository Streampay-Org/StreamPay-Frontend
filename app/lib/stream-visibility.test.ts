import jwt from "jsonwebtoken";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  signToken,
} from "@/app/lib/auth";
import { getAdminAddress } from "@/app/lib/admin-guard";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import { DEFAULT_STREAM_TENANT_ID } from "@/app/lib/stream-tenant";
import {
  STREAM_PII_FIELDS,
  redactStreamPii,
  resolveRequestActor,
  resolveStreamTenant,
  visibleTo,
} from "@/app/lib/stream-visibility";
import type { Stream } from "@/app/types/openapi";

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  allowActorHeader: process.env.STREAMPAY_ALLOW_ACTOR_HEADER,
};

const SENDER_WALLET = "GSENDER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWN01";
const RECIPIENT_WALLET = "GRECIP7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWN02";
const UNRELATED_WALLET = "GOTHER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWN03";
const ACME_VIEWER_WALLET = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const BETA_OWNER_WALLET = "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-test-1",
    recipient: RECIPIENT_WALLET,
    senderAddress: SENDER_WALLET,
    rate: "100 XLM / month",
    schedule: "Monthly",
    status: "active",
    nextAction: "pause",
    token: "XLM",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

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

describe("stream-visibility", () => {
  beforeEach(() => {
    _resetOrgDbForTesting();
  });

  describe("STREAM_PII_FIELDS", () => {
    it("pins the exact list of redacted PII fields", () => {
      expect([...STREAM_PII_FIELDS]).toEqual([
        "email",
        "label",
        "memo",
        "partnerId",
      ]);
    });
  });

  describe("resolveStreamTenant", () => {
    it("prefers tenantId over tenant when both are present", () => {
      const stream = makeStream({
        tenantId: "tenant-primary",
        tenant: "tenant-secondary",
      });
      expect(resolveStreamTenant(stream)).toBe("tenant-primary");
    });

    it("falls back to tenant when tenantId is unset or blank", () => {
      expect(
        resolveStreamTenant(makeStream({ tenantId: "   ", tenant: "tenant-a" })),
      ).toBe("tenant-a");
      expect(resolveStreamTenant(makeStream({ tenant: "tenant-b" }))).toBe(
        "tenant-b",
      );
    });

    it("falls back to default-tenant when neither tenantId nor tenant is set", () => {
      expect(resolveStreamTenant(makeStream())).toBe(DEFAULT_STREAM_TENANT_ID);
      expect(
        resolveStreamTenant(makeStream({ tenantId: "", tenant: "   " })),
      ).toBe(DEFAULT_STREAM_TENANT_ID);
    });
  });

  describe("visibleTo", () => {
    describe("sender and recipient ownership", () => {
      it("allows the stream sender to see the stream", () => {
        const stream = makeStream();
        expect(visibleTo({ walletAddress: SENDER_WALLET })(stream)).toBe(true);
      });

      it("allows the stream recipient to see the stream", () => {
        const stream = makeStream();
        expect(visibleTo({ walletAddress: RECIPIENT_WALLET })(stream)).toBe(
          true,
        );
      });

      it("hides the stream from an unrelated wallet", () => {
        const stream = makeStream();
        expect(visibleTo({ walletAddress: UNRELATED_WALLET })(stream)).toBe(
          false,
        );
      });

      it("hides the stream from sender and recipient on a different tenant", () => {
        const stream = makeStream({ tenantId: "tenant-alpha" });
        expect(
          visibleTo({ walletAddress: SENDER_WALLET }, "tenant-beta")(stream),
        ).toBe(false);
        expect(
          visibleTo({ walletAddress: RECIPIENT_WALLET }, "tenant-beta")(stream),
        ).toBe(false);
      });
    });

    describe("string-address actors", () => {
      it("matches sender, recipient, and org-member string wallet addresses", () => {
        const individualStream = makeStream();
        expect(visibleTo(SENDER_WALLET)(individualStream)).toBe(true);
        expect(visibleTo(RECIPIENT_WALLET)(individualStream)).toBe(true);

        const acmeStream = makeStream({ id: "stream-ada" });
        expect(visibleTo(ACME_VIEWER_WALLET)(acmeStream)).toBe(true);
      });

      it("hides streams from an unrelated string wallet address", () => {
        const stream = makeStream();
        expect(visibleTo(UNRELATED_WALLET)(stream)).toBe(false);
      });
    });

    describe("organisation membership", () => {
      it("allows an org-acme member to see seeded stream-ada", () => {
        const acmeStream = makeStream({ id: "stream-ada" });
        expect(visibleTo({ walletAddress: ACME_VIEWER_WALLET })(acmeStream)).toBe(
          true,
        );
      });

      it("hides seeded stream-ada from a member of another org (org-beta)", () => {
        const acmeStream = makeStream({ id: "stream-ada" });
        expect(visibleTo({ walletAddress: BETA_OWNER_WALLET })(acmeStream)).toBe(
          false,
        );
      });

      it("hides an individually owned stream from an org-acme member", () => {
        const individualStream = makeStream({ id: "stream-individual" });
        expect(
          visibleTo({ walletAddress: ACME_VIEWER_WALLET })(individualStream),
        ).toBe(false);
      });

      it("respects actor orgIds against stream.orgId and denies non-matching orgIds", () => {
        const orgStream = makeStream({ id: "stream-org-2", orgId: "org-acme" });
        expect(
          visibleTo({ walletAddress: UNRELATED_WALLET, orgIds: ["org-acme"] })(
            orgStream,
          ),
        ).toBe(true);
        expect(
          visibleTo({ walletAddress: UNRELATED_WALLET, orgIds: ["org-beta"] })(
            orgStream,
          ),
        ).toBe(false);
      });

      it("does not leak orgDb mutations across tests", () => {
        orgDb.streamOwnership.set("stream-ephemeral", "org-acme");
        const ephemeral = makeStream({ id: "stream-ephemeral" });
        expect(visibleTo(ACME_VIEWER_WALLET)(ephemeral)).toBe(true);
      });

      it("starts with a clean seeded orgDb after mutations in earlier tests", () => {
        const ephemeral = makeStream({ id: "stream-ephemeral" });
        expect(visibleTo(ACME_VIEWER_WALLET)(ephemeral)).toBe(false);
      });
    });

    describe("admin actors", () => {
      it("allows an actor with isAdmin: true to see any stream in the same tenant", () => {
        const stream = makeStream();
        expect(
          visibleTo({ walletAddress: UNRELATED_WALLET, isAdmin: true })(stream),
        ).toBe(true);
      });

      it("allows an actor with role: 'admin' to see any stream in the same tenant", () => {
        const stream = makeStream();
        expect(
          visibleTo({ walletAddress: UNRELATED_WALLET, role: "admin" })(stream),
        ).toBe(true);
      });

      it("does not treat role: 'admin' as admin when isAdmin is explicitly false", () => {
        const stream = makeStream();
        expect(
          visibleTo({
            walletAddress: UNRELATED_WALLET,
            role: "admin",
            isAdmin: false,
          })(stream),
        ).toBe(false);
      });

      it("still blocks admin actors from cross-tenant streams", () => {
        const stream = makeStream({ tenantId: "tenant-alpha" });
        expect(
          visibleTo(
            { walletAddress: UNRELATED_WALLET, isAdmin: true },
            "tenant-beta",
          )(stream),
        ).toBe(false);
        expect(
          visibleTo(
            { walletAddress: UNRELATED_WALLET, role: "admin" },
            "tenant-beta",
          )(stream),
        ).toBe(false);
      });
    });

    describe("anonymous callers and tenant resolution", () => {
      it("allows null and undefined actors when the tenant matches", () => {
        const defaultStream = makeStream();
        expect(visibleTo(null)(defaultStream)).toBe(true);
        expect(visibleTo(undefined)(defaultStream)).toBe(true);

        const scopedStream = makeStream({ tenantId: "tenant-x" });
        expect(visibleTo(null, "tenant-x")(scopedStream)).toBe(true);
        expect(visibleTo(undefined, "tenant-x")(scopedStream)).toBe(true);
      });

      it("hides streams from null and undefined actors when the tenant does not match", () => {
        const scopedStream = makeStream({ tenantId: "tenant-x" });
        expect(visibleTo(null, "tenant-y")(scopedStream)).toBe(false);
        expect(visibleTo(undefined, "tenant-y")(scopedStream)).toBe(false);
        expect(visibleTo(null)(scopedStream)).toBe(false);
      });

      it("uses tenantId over tenant, and defaults to default-tenant when omitted", () => {
        const bothTenants = makeStream({
          tenantId: "tenant-id-wins",
          tenant: "tenant-fallback",
        });
        expect(visibleTo(null, "tenant-id-wins")(bothTenants)).toBe(true);
        expect(visibleTo(null, "tenant-fallback")(bothTenants)).toBe(false);

        const tenantOnly = makeStream({ tenant: "tenant-only" });
        expect(visibleTo(null, "tenant-only")(tenantOnly)).toBe(true);
        expect(visibleTo(null, DEFAULT_STREAM_TENANT_ID)(tenantOnly)).toBe(
          false,
        );

        const defaultTenant = makeStream();
        expect(visibleTo(null, DEFAULT_STREAM_TENANT_ID)(defaultTenant)).toBe(
          true,
        );
        expect(visibleTo(null, "other-tenant")(defaultTenant)).toBe(false);
      });
    });
  });

  describe("redactStreamPii", () => {
    it("removes all STREAM_PII_FIELDS while preserving non-PII fields", () => {
      const stream = makeStream({
        id: "stream-pii-1",
        tenantId: "tenant-a",
        orgId: "org-acme",
        email: "alice@example.com",
        label: "Payroll",
        memo: "Q2 bonus",
        partnerId: "partner-42",
        totalAmount: "1000000",
      });

      const redacted = redactStreamPii(stream);

      for (const field of STREAM_PII_FIELDS) {
        expect(redacted[field]).toBeUndefined();
        expect(field in redacted).toBe(false);
      }

      expect(redacted).toEqual({
        id: "stream-pii-1",
        recipient: RECIPIENT_WALLET,
        senderAddress: SENDER_WALLET,
        rate: "100 XLM / month",
        schedule: "Monthly",
        status: "active",
        nextAction: "pause",
        token: "XLM",
        tenantId: "tenant-a",
        orgId: "org-acme",
        totalAmount: "1000000",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });
    });

    it("does not mutate the input stream object", () => {
      const original = makeStream({
        email: "bob@example.com",
        label: "Contractor",
        memo: "Invoice #9",
        partnerId: "partner-99",
      });
      const snapshot = { ...original };

      const redacted = redactStreamPii(original);

      expect(redacted).not.toBe(original);
      expect(original).toEqual(snapshot);
    });
  });
});
