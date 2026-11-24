import { GET, PATCH, DELETE } from "./route";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { auditLogStore } from "@/app/lib/audit-log";
import { NextRequest } from "next/server";

const ACME_ORG_ID = "org-acme";
const ACME_OWNER = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const BETA_ORG_ID = "org-beta";
const BETA_OWNER = "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA";
const MISSING_ORG_ID = "org-does-not-exist";

function makeRequest(
  method: string,
  orgId: string,
  options: { actor?: string; body?: unknown } = {},
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.actor) headers["Actor-Wallet-Address"] = options.actor;

  const init = {
    method,
    headers,
    ...(options.body !== undefined
      ? {
          body:
            typeof options.body === "string"
              ? options.body
              : JSON.stringify(options.body),
        }
      : {}),
  } as ConstructorParameters<typeof NextRequest>[1];

  return new NextRequest(`http://localhost/api/orgs/${orgId}`, init);
}

function addPendingApproval(orgId: string) {
  orgDb.approvals.set("approval-1", {
    id: "approval-1",
    streamId: "stream-pending",
    orgId,
    action: "settle",
    initiatedBy: BETA_OWNER,
    approvals: [],
    requiredCount: 2,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe("Org API", () => {
  beforeEach(() => {
    _resetOrgDbForTesting();
    auditLogStore.reset([]);
  });

  describe("GET /api/orgs/:orgId", () => {
    it("returns org details for an existing org", async () => {
      const res = await GET(makeRequest("GET", ACME_ORG_ID), {
        params: Promise.resolve({ orgId: ACME_ORG_ID }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(ACME_ORG_ID);
      expect(body.data.ownedStreams).toContain("stream-ada");
    });

    it("returns 404 for an unknown org", async () => {
      const res = await GET(makeRequest("GET", MISSING_ORG_ID), {
        params: Promise.resolve({ orgId: MISSING_ORG_ID }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("ORG_NOT_FOUND");
    });
  });

  describe("PATCH /api/orgs/:orgId", () => {
    it("allows an owner to rename the org and records an audit entry", async () => {
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, {
          actor: BETA_OWNER,
          body: { name: "  Beta Corporation  " },
        }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe("Beta Corporation");
      expect(orgDb.orgs.get(BETA_ORG_ID)?.name).toBe("Beta Corporation");

      const entries = auditLogStore.list({ orgId: BETA_ORG_ID });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("org.rename");
      expect(entries[0].metadata).toMatchObject({
        fromName: "Beta Corp",
        orgId: BETA_ORG_ID,
        toName: "Beta Corporation",
      });
    });

    it("returns 404 for an unknown org", async () => {
      const res = await PATCH(
        makeRequest("PATCH", MISSING_ORG_ID, {
          actor: BETA_OWNER,
          body: { name: "New Name" },
        }),
        { params: Promise.resolve({ orgId: MISSING_ORG_ID }) },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("ORG_NOT_FOUND");
    });

    it("rejects non-owner actors with 403", async () => {
      const res = await PATCH(
        makeRequest("PATCH", ACME_ORG_ID, {
          actor: "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS",
          body: { name: "Hijacked" },
        }),
        { params: Promise.resolve({ orgId: ACME_ORG_ID }) },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    });

    it("rejects requests without an actor header with 403", async () => {
      const res = await PATCH(
        makeRequest("PATCH", ACME_ORG_ID, { body: { name: "Hijacked" } }),
        { params: Promise.resolve({ orgId: ACME_ORG_ID }) },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    });

    it("returns 422 for a blank name", async () => {
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, {
          actor: BETA_OWNER,
          body: { name: "   " },
        }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 422 when the name is longer than 100 characters", async () => {
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, {
          actor: BETA_OWNER,
          body: { name: "x".repeat(101) },
        }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts a name of exactly 100 characters", async () => {
      const name = "x".repeat(100);
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, { actor: BETA_OWNER, body: { name } }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.name).toBe(name);
    });

    it("returns 422 when the name is missing or not a string", async () => {
      for (const body of [{}, { name: 42 }]) {
        const res = await PATCH(
          makeRequest("PATCH", BETA_ORG_ID, { actor: BETA_OWNER, body }),
          { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
        );
        expect(res.status).toBe(422);
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, { actor: BETA_OWNER, body: "{not-json" }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_REQUEST");
    });

    it("returns 400 for an empty body", async () => {
      const res = await PATCH(
        makeRequest("PATCH", BETA_ORG_ID, { actor: BETA_OWNER, body: "" }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("EMPTY_BODY");
    });
  });

  describe("DELETE /api/orgs/:orgId", () => {
    it("allows an owner to delete an org without streams or approvals", async () => {
      const res = await DELETE(
        makeRequest("DELETE", BETA_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );

      expect(res.status).toBe(204);
      expect(orgDb.orgs.has(BETA_ORG_ID)).toBe(false);

      const entries = auditLogStore.list({ orgId: BETA_ORG_ID });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("org.delete");
      expect(entries[0].metadata).toMatchObject({ name: "Beta Corp", orgId: BETA_ORG_ID });
    });

    it("returns 409 ORG_HAS_STREAMS when the org still owns a stream", async () => {
      const res = await DELETE(
        makeRequest("DELETE", ACME_ORG_ID, { actor: ACME_OWNER }),
        { params: Promise.resolve({ orgId: ACME_ORG_ID }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("ORG_HAS_STREAMS");
      expect(orgDb.orgs.has(ACME_ORG_ID)).toBe(true);
    });

    it("returns 409 ORG_HAS_PENDING_APPROVALS when active approvals exist", async () => {
      addPendingApproval(BETA_ORG_ID);

      const res = await DELETE(
        makeRequest("DELETE", BETA_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("ORG_HAS_PENDING_APPROVALS");
      expect(orgDb.orgs.has(BETA_ORG_ID)).toBe(true);
    });

    it("ignores expired or terminal approvals", async () => {
      orgDb.approvals.set("approval-expired", {
        id: "approval-expired",
        streamId: "stream-old",
        orgId: BETA_ORG_ID,
        action: "stop",
        initiatedBy: BETA_OWNER,
        approvals: [],
        requiredCount: 2,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      orgDb.approvals.set("approval-approved", {
        id: "approval-approved",
        streamId: "stream-done",
        orgId: BETA_ORG_ID,
        action: "settle",
        initiatedBy: BETA_OWNER,
        approvals: [BETA_OWNER],
        requiredCount: 1,
        status: "approved",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const res = await DELETE(
        makeRequest("DELETE", BETA_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(204);
    });

    it("returns 403 for non-owners and unknown actors", async () => {
      for (const actor of [
        "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS",
        undefined,
      ]) {
        const res = await DELETE(
          makeRequest("DELETE", BETA_ORG_ID, { actor }),
          { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
        );
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("FORBIDDEN");
      }
    });

    it("returns 404 for an unknown org and on a second delete", async () => {
      const missing = await DELETE(
        makeRequest("DELETE", MISSING_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: MISSING_ORG_ID }) },
      );
      expect(missing.status).toBe(404);

      const first = await DELETE(
        makeRequest("DELETE", BETA_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(first.status).toBe(204);

      const second = await DELETE(
        makeRequest("DELETE", BETA_ORG_ID, { actor: BETA_OWNER }),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(second.status).toBe(404);
      expect((await second.json()).error.code).toBe("ORG_NOT_FOUND");
    });
  });
});
