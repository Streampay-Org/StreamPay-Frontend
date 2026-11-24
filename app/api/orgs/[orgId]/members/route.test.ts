import { GET, POST, PATCH, DELETE } from "./route";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { auditLogStore } from "@/app/lib/audit-log";
import { NextRequest } from "next/server";

const OWNER_WALLET = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const PAUSER_WALLET = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";
const VIEWER_WALLET = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const BETA_OWNER_WALLET = "GBETA7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRWA";
const EXISTING_ORG_ID = "org-acme";
const BETA_ORG_ID = "org-beta";
const MISSING_ORG_ID = "org-does-not-exist";
const MISSING_WALLET = "GMISSING7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNR";
const encoder = new TextEncoder();

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function makeChunkedPostRequest(body: ReadableStream<Uint8Array> | null): Request {
  return {
    url: `http://localhost/api/orgs/${EXISTING_ORG_ID}/members`,
    method: "POST",
    headers: new Headers({
      "Actor-Wallet-Address": OWNER_WALLET,
      "Content-Type": "application/json",
    }),
    body,
  } as unknown as Request;
}

describe("Org Members API", () => {
  beforeEach(() => {
    _resetOrgDbForTesting();
    auditLogStore.reset([]);
  });

  describe("GET /api/orgs/:orgId/members", () => {
    it("returns 404 ORG_NOT_FOUND when the org does not exist", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${MISSING_ORG_ID}/members`,
      );
      const res = await GET(req, { params: Promise.resolve({ orgId: MISSING_ORG_ID }) });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("ORG_NOT_FOUND");
      expect(body.error.message).toContain(MISSING_ORG_ID);
      expect(body.error.request_id).toBeDefined();
    });

    it("returns members for an existing org", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${EXISTING_ORG_ID}/members`,
      );
      const res = await GET(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.meta.total).toBe(body.data.length);
      expect(body.meta.hasNext).toBe(false);
      expect(body.meta.nextCursor).toBeNull();
      expect(body.links.self).toBe(`/api/orgs/${EXISTING_ORG_ID}/members`);
    });

    describe("pagination", () => {
      beforeEach(() => {
        _resetOrgDbForTesting();
      });

      afterEach(() => {
        _resetOrgDbForTesting();
      });

      it("walks all members with limit=1 in stable (addedAt, walletAddress) order", async () => {
        const org = orgDb.orgs.get(EXISTING_ORG_ID)!;
        org.members = [
          {
            walletAddress: "GMB27MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW2",
            role: "viewer",
            addedAt: "2026-04-01T00:00:00Z",
          },
          {
            walletAddress: "GMB17MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW1",
            role: "owner",
            addedAt: "2026-04-01T00:00:00Z",
          },
          {
            walletAddress: "GMB37MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW3",
            role: "pauser",
            addedAt: "2026-04-02T00:00:00Z",
          },
          {
            walletAddress: "GMB47MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW4",
            role: "settler",
            addedAt: "2026-04-03T00:00:00Z",
          },
        ];

        const collected: string[] = [];
        let cursor: string | null = null;

        do {
          const url = cursor
            ? `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=1&cursor=${encodeURIComponent(cursor)}`
            : `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=1`;
          const res = await GET(new NextRequest(url), {
            params: Promise.resolve({ orgId: EXISTING_ORG_ID }),
          });
          expect(res.status).toBe(200);
          const body = await res.json();

          expect(body.meta.total).toBe(4);
          expect(body.data).toHaveLength(1);
          collected.push(body.data[0].walletAddress);
          cursor = body.meta.nextCursor;
          expect(body.meta.hasNext).toBe(cursor !== null);
        } while (cursor !== null);

        expect(collected).toEqual([
          "GMB17MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW1",
          "GMB27MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW2",
          "GMB37MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW3",
          "GMB47MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW4",
        ]);
      });

      it("returns hasNext=false and nextCursor=null when total equals limit", async () => {
        const org = orgDb.orgs.get(EXISTING_ORG_ID)!;
        const req = new NextRequest(
          `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=${org.members.length}`,
        );
        const res = await GET(req, {
          params: Promise.resolve({ orgId: EXISTING_ORG_ID }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toHaveLength(org.members.length);
        expect(body.meta).toEqual({
          total: org.members.length,
          hasNext: false,
          nextCursor: null,
        });
      });

      it("resumes cleanly when the member referenced by the cursor is removed", async () => {
        const org = orgDb.orgs.get(EXISTING_ORG_ID)!;
        org.members = [...org.members];

        const first = await GET(
          new NextRequest(
            `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=2`,
          ),
          { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
        );
        expect(first.status).toBe(200);
        const firstBody = await first.json();
        expect(firstBody.data).toHaveLength(2);
        expect(firstBody.meta.hasNext).toBe(true);

        const removedWallet = firstBody.data[1].walletAddress;
        org.members = org.members.filter((m) => m.walletAddress !== removedWallet);

        const second = await GET(
          new NextRequest(
            `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=2&cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`,
          ),
          { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
        );
        expect(second.status).toBe(200);
        const secondBody = await second.json();
        expect(secondBody.data).toHaveLength(2);
        expect(secondBody.data.map((m: { walletAddress: string }) => m.walletAddress)).not.toContain(
          removedWallet,
        );
        expect(secondBody.meta.hasNext).toBe(false);
        expect(secondBody.meta.nextCursor).toBeNull();
      });

      it.each(["0", "-1", "101", "abc", "1.5"])(
        "returns 422 VALIDATION_ERROR for invalid limit=%s",
        async (limit) => {
          const req = new NextRequest(
            `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?limit=${limit}`,
          );
          const res = await GET(req, {
            params: Promise.resolve({ orgId: EXISTING_ORG_ID }),
          });
          expect(res.status).toBe(422);
          const body = await res.json();
          expect(body.error.code).toBe("VALIDATION_ERROR");
        },
      );

      it("returns 422 INVALID_CURSOR for malformed cursor", async () => {
        const req = new NextRequest(
          `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?cursor=not-a-valid-cursor`,
        );
        const res = await GET(req, {
          params: Promise.resolve({ orgId: EXISTING_ORG_ID }),
        });
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error.code).toBe("INVALID_CURSOR");
      });
    });
  });

  describe("POST /api/orgs/:orgId/members", () => {
    it("returns 404 ORG_NOT_FOUND when the org does not exist", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${MISSING_ORG_ID}/members`,
        {
          method: "POST",
          headers: {
            "Actor-Wallet-Address": OWNER_WALLET,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            walletAddress: "GNEW7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW",
            role: "viewer",
          }),
        },
      );
      const res = await POST(req, { params: Promise.resolve({ orgId: MISSING_ORG_ID }) });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("ORG_NOT_FOUND");
      expect(body.error.message).toContain(MISSING_ORG_ID);
    });

    it("allows an owner to add a member", async () => {
      const newWallet = "GNEW7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
      const req = new NextRequest(
        `http://localhost/api/orgs/${EXISTING_ORG_ID}/members`,
        {
          method: "POST",
          headers: {
            "Actor-Wallet-Address": OWNER_WALLET,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ walletAddress: newWallet, role: "viewer" }),
        },
      );
      const res = await POST(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.walletAddress).toBe(newWallet);
      expect(body.data.role).toBe("viewer");

      const org = orgDb.orgs.get(EXISTING_ORG_ID);
      expect(org?.members.some((m) => m.walletAddress === newWallet)).toBe(true);
    });

    it("rejects non-owner actors", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${EXISTING_ORG_ID}/members`,
        {
          method: "POST",
          headers: {
            "Actor-Wallet-Address": "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            walletAddress: "GATTACK7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNR",
            role: "viewer",
          }),
        },
      );
      const res = await POST(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("accepts a chunked body with no Content-Length", async () => {
      const walletAddress = "GCHUNK7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNR";
      const req = makeChunkedPostRequest(
        // One JSON object split across two chunks.
        streamFromChunks([
          JSON.stringify({ walletAddress }).slice(0, -1),
          ',"role":"viewer"}',
        ]),
      );
      const res = await POST(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.walletAddress).toBe(walletAddress);
    });

    it("returns 413 for a chunked body over the limit", async () => {
      const req = makeChunkedPostRequest(
        streamFromChunks([new Uint8Array(300 * 1024)]),
      );
      const res = await POST(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("REQUEST_TOO_LARGE");
      expect(body.error.request_id).toBeDefined();
    });

    it("returns 400 EMPTY_BODY for an empty body", async () => {
      const req = makeChunkedPostRequest(streamFromChunks([]));
      const res = await POST(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("EMPTY_BODY");
    });
  });

  describe("PATCH /api/orgs/:orgId/members", () => {
    function makePatchRequest(
      body: unknown,
      actor: string = OWNER_WALLET,
      orgId: string = EXISTING_ORG_ID,
    ): NextRequest {
      return new NextRequest(`http://localhost/api/orgs/${orgId}/members`, {
        method: "PATCH",
        headers: {
          "Actor-Wallet-Address": actor,
          "Content-Type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    it("returns 404 when the org does not exist", async () => {
      const res = await PATCH(
        makePatchRequest({ walletAddress: PAUSER_WALLET, role: "viewer" }, OWNER_WALLET, MISSING_ORG_ID),
        { params: Promise.resolve({ orgId: MISSING_ORG_ID }) },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("ORG_NOT_FOUND");
    });

    it("allows an owner to change a member role and records an audit entry", async () => {
      const res = await PATCH(
        makePatchRequest({ walletAddress: PAUSER_WALLET, role: "viewer" }),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.walletAddress).toBe(PAUSER_WALLET);
      expect(body.data.role).toBe("viewer");

      const member = orgDb.orgs
        .get(EXISTING_ORG_ID)
        ?.members.find((m) => m.walletAddress === PAUSER_WALLET);
      expect(member?.role).toBe("viewer");

      const entries = auditLogStore.list({ orgId: EXISTING_ORG_ID });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("org.member.role_changed");
      expect(entries[0].metadata).toMatchObject({
        fromRole: "pauser",
        orgId: EXISTING_ORG_ID,
        toRole: "viewer",
        walletAddress: PAUSER_WALLET,
      });
    });

    it("rejects non-owner actors with 403", async () => {
      const res = await PATCH(
        makePatchRequest(
          { walletAddress: VIEWER_WALLET, role: "viewer" },
          PAUSER_WALLET,
        ),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    });

    it("returns 404 MEMBER_NOT_FOUND for an unknown member", async () => {
      const res = await PATCH(
        makePatchRequest({ walletAddress: MISSING_WALLET, role: "viewer" }),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("MEMBER_NOT_FOUND");
    });

    it("returns 422 VALIDATION_ERROR for an invalid role", async () => {
      const res = await PATCH(
        makePatchRequest({ walletAddress: PAUSER_WALLET, role: "superuser" }),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 LAST_OWNER when demoting the only owner", async () => {
      const res = await PATCH(
        makePatchRequest({ walletAddress: BETA_OWNER_WALLET, role: "viewer" }, BETA_OWNER_WALLET, BETA_ORG_ID),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("LAST_OWNER");
    });

    it("allows demoting one of two owners", async () => {
      const secondOwner = "GSECOND7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNR";
      const beta = orgDb.orgs.get(BETA_ORG_ID)!;
      beta.members.push({ walletAddress: secondOwner, role: "owner", addedAt: new Date().toISOString() });

      const res = await PATCH(
        makePatchRequest({ walletAddress: BETA_OWNER_WALLET, role: "pauser" }, BETA_OWNER_WALLET, BETA_ORG_ID),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.role).toBe("pauser");
      expect(orgDb.orgs.get(BETA_ORG_ID)?.members.filter((m) => m.role === "owner")).toHaveLength(1);
    });

    it("returns 400 INVALID_REQUEST for malformed JSON", async () => {
      const res = await PATCH(
        makePatchRequest("{not-json"),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_REQUEST");
    });

    it("returns 400 EMPTY_BODY for an empty body", async () => {
      const res = await PATCH(
        makePatchRequest(""),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("EMPTY_BODY");
    });
  });

  describe("DELETE /api/orgs/:orgId/members", () => {
    function makeDeleteRequest(
      body: unknown,
      actor: string = OWNER_WALLET,
      orgId: string = EXISTING_ORG_ID,
    ): NextRequest {
      return new NextRequest(`http://localhost/api/orgs/${orgId}/members`, {
        method: "DELETE",
        headers: {
          "Actor-Wallet-Address": actor,
          "Content-Type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    it("returns 404 when the org does not exist", async () => {
      const res = await DELETE(
        makeDeleteRequest({ walletAddress: VIEWER_WALLET }, OWNER_WALLET, MISSING_ORG_ID),
        { params: Promise.resolve({ orgId: MISSING_ORG_ID }) },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("ORG_NOT_FOUND");
    });

    it("allows an owner to remove a member and records an audit entry", async () => {
      const res = await DELETE(
        makeDeleteRequest({ walletAddress: VIEWER_WALLET }),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ removed: true, walletAddress: VIEWER_WALLET });
      expect(
        orgDb.orgs.get(EXISTING_ORG_ID)?.members.some((m) => m.walletAddress === VIEWER_WALLET),
      ).toBe(false);

      const entries = auditLogStore.list({ orgId: EXISTING_ORG_ID });
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("org.member.removed");
      expect(entries[0].metadata).toMatchObject({
        fromRole: "viewer",
        orgId: EXISTING_ORG_ID,
        toRole: null,
        walletAddress: VIEWER_WALLET,
      });
    });

    it("accepts the wallet address from the query string", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${EXISTING_ORG_ID}/members?walletAddress=${VIEWER_WALLET}`,
        { method: "DELETE", headers: { "Actor-Wallet-Address": OWNER_WALLET } },
      );
      const res = await DELETE(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });
      expect(res.status).toBe(200);
      expect(
        orgDb.orgs.get(EXISTING_ORG_ID)?.members.some((m) => m.walletAddress === VIEWER_WALLET),
      ).toBe(false);
    });

    it("rejects non-owner actors with 403", async () => {
      const res = await DELETE(
        makeDeleteRequest({ walletAddress: VIEWER_WALLET }, PAUSER_WALLET),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("FORBIDDEN");
    });

    it("returns 404 MEMBER_NOT_FOUND for an unknown member", async () => {
      const res = await DELETE(
        makeDeleteRequest({ walletAddress: MISSING_WALLET }),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("MEMBER_NOT_FOUND");
    });

    it("returns 409 LAST_OWNER when removing the only owner", async () => {
      const res = await DELETE(
        makeDeleteRequest({ walletAddress: BETA_OWNER_WALLET }, BETA_OWNER_WALLET, BETA_ORG_ID),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe("LAST_OWNER");
    });

    it("allows an owner to remove themselves when another owner remains", async () => {
      const secondOwner = "GSECOND7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNR";
      const beta = orgDb.orgs.get(BETA_ORG_ID)!;
      beta.members.push({ walletAddress: secondOwner, role: "owner", addedAt: new Date().toISOString() });

      const res = await DELETE(
        makeDeleteRequest({ walletAddress: BETA_OWNER_WALLET }, BETA_OWNER_WALLET, BETA_ORG_ID),
        { params: Promise.resolve({ orgId: BETA_ORG_ID }) },
      );

      expect(res.status).toBe(200);
      expect(orgDb.orgs.get(BETA_ORG_ID)?.members).toHaveLength(1);
      expect(orgDb.orgs.get(BETA_ORG_ID)?.members[0].walletAddress).toBe(secondOwner);
    });

    it("returns 400 INVALID_REQUEST for malformed JSON", async () => {
      const res = await DELETE(
        makeDeleteRequest("{not-json"),
        { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) },
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_REQUEST");
    });

    it("returns 400 EMPTY_BODY when neither body nor query is provided", async () => {
      const req = new NextRequest(
        `http://localhost/api/orgs/${EXISTING_ORG_ID}/members`,
        { method: "DELETE", headers: { "Actor-Wallet-Address": OWNER_WALLET } },
      );
      const res = await DELETE(req, { params: Promise.resolve({ orgId: EXISTING_ORG_ID }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("EMPTY_BODY");
    });
  });
});
