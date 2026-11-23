import { GET, POST } from "./route";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { NextRequest } from "next/server";

const OWNER_WALLET = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const EXISTING_ORG_ID = "org-acme";
const MISSING_ORG_ID = "org-does-not-exist";
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
});
