/**
 * @jest-environment node
 *
 * GET /api/streams query validation — limit, status, and cursor are
 * validated at the boundary and rejected with 422 VALIDATION_ERROR plus
 * per-field details instead of silently degrading (a malformed limit
 * previously produced an empty list).
 */

import * as fc from "fast-check";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { GET as listStreams, POST as createStream } from "@/app/api/streams/route";
import type { Stream } from "@/app/types/openapi";

const VALID_STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function getRequest(query: string = "") {
  return new Request(`http://localhost/api/streams${query}`);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedStreams(count: number) {
  for (let i = 0; i < count; i++) {
    const res = await createStream(
      postRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    expect(res.status).toBe(201);
  }
}

/** Adds one stream at a known position in the `(createdAt, id)` ordering. */
function seedStreamAt(id: string, createdAt: string) {
  const stream: Stream = {
    createdAt,
    id,
    nextAction: "start",
    rate: "50",
    recipient: VALID_STELLAR_KEY,
    schedule: "month",
    status: "draft",
    token: "XLM",
    updatedAt: createdAt,
  };
  getStore().streamRepository.streams.set(id, stream);
}

/** Empties the stream store so a pagination walk only sees the seeded rows. */
function clearStreams() {
  getStore().streamRepository.streams.clear();
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
});

describe("GET /api/streams query validation", () => {
  it("returns 200 with defaults when no query params are given", async () => {
    const res = await listStreams(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("applies a valid limit", async () => {
    await seedStreams(3);
    const res = await listStreams(getRequest("?limit=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.hasNext).toBe(true);
  });

  it("returns 422 with a limit detail for a non-numeric limit", async () => {
    const res = await listStreams(getRequest("?limit=abc"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      expect.objectContaining({ field: "limit" }),
    ]);
  });

  it("returns 422 when limit is out of range", async () => {
    for (const value of ["0", "101"]) {
      const res = await listStreams(getRequest(`?limit=${value}`));
      expect(res.status).toBe(422);
    }
  });

  it("filters by a valid status", async () => {
    await seedStreams(2);
    const res = await listStreams(getRequest("?status=draft"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const stream of body.data) {
      expect(stream.status).toBe("draft");
    }
  });

  it("returns 422 with a status detail for an unknown status", async () => {
    const res = await listStreams(getRequest("?status=bogus"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details).toEqual([
      expect.objectContaining({ field: "status" }),
    ]);
  });

  it("returns 422 for an empty cursor param", async () => {
    const res = await listStreams(getRequest("?cursor="));
    expect(res.status).toBe(422);
  });

  it("returns 422 for a cursor that does not resolve to a stream", async () => {
    const res = await listStreams(getRequest("?cursor=bm8tc3VjaC1pZA=="));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("ignores unknown query params", async () => {
    await seedStreams(1);
    const res = await listStreams(getRequest("?foo=bar"));
    expect(res.status).toBe(200);
  });

  it("returns 422 for a cursor that is not base64", async () => {
    const res = await listStreams(getRequest("?cursor=not-base64"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 422 for base64 that is not a cursor", async () => {
    const cursor = Buffer.from("garbage").toString("base64");
    const res = await listStreams(getRequest(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("accepts a legacy plain-id cursor while the stream still exists", async () => {
    clearStreams();
    seedStreamAt("stream-legacy", "2026-01-01T00:00:00.000Z");
    seedStreamAt("stream-after", "2026-01-02T00:00:00.000Z");

    const cursor = Buffer.from("stream-legacy").toString("base64");
    const res = await listStreams(getRequest(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((stream: { id: string }) => stream.id)).toEqual(["stream-after"]);
  });

  it("walks every page exactly once", async () => {
    clearStreams();
    for (let index = 0; index < 7; index += 1) {
      seedStreamAt(`stream-page-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const res = await listStreams(getRequest(query));
      expect(res.status).toBe(200);
      const body = await res.json();
      pages += 1;
      for (const stream of body.data) {
        seen.push(stream.id);
      }
      cursor = body.meta.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
    expect(cursor).toBeNull();
  });

  it("resumes after the cursor row instead of restarting at page one", async () => {
    clearStreams();
    for (let index = 0; index < 5; index += 1) {
      seedStreamAt(`stream-page-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`);
    }

    const first = await listStreams(getRequest("?limit=2"));
    const firstBody = await first.json();
    expect(firstBody.data.map((stream: { id: string }) => stream.id)).toEqual([
      "stream-page-0",
      "stream-page-1",
    ]);

    // The row the cursor points at disappears between the two requests.
    getStore().streamRepository.streams.delete("stream-page-1");

    const second = await listStreams(
      getRequest(`?limit=2&cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.map((stream: { id: string }) => stream.id)).toEqual([
      "stream-page-2",
      "stream-page-3",
    ]);
  });

  it("never repeats a stream while walking the pages (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        async (gaps, limit) => {
          // Every case starts from an empty store and a fresh rate-limit
          // bucket, so the walk only sees the seeded rows and is never
          // throttled by the requests the previous cases made.
          resetRateLimitStore();
          clearStreams();

          const expected: string[] = [];
          let minute = 0;
          gaps.forEach((gap, index) => {
            minute += gap;
            const id = `stream-prop-${String(index).padStart(2, "0")}`;
            expected.push(id);
            seedStreamAt(id, `2026-02-01T00:${String(minute).padStart(2, "0")}:00.000Z`);
          });

          const seen: string[] = [];
          let cursor: string | null = null;
          let guard = 0;

          do {
            guard += 1;
            expect(guard).toBeLessThanOrEqual(40);
            const query = cursor
              ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
              : `?limit=${limit}`;
            const res = await listStreams(getRequest(query));
            expect(res.status).toBe(200);
            const body = await res.json();
            for (const stream of body.data) {
              seen.push(stream.id);
            }
            cursor = body.meta.nextCursor;
          } while (cursor);

          // Every stream is seen exactly once, in list order.
          expect(seen).toEqual(expected);

          // fast-check requires an explicit `true` from the predicate.
          return true;
        },
      ),
      { numRuns: 20, seed: 42 },
    );
  });

  describe("tenant and ownership scoping (issue #1732)", () => {
    const { GET: listStreamsV2 } = require("@/app/api/v2/streams/route") as typeof import("@/app/api/v2/streams/route");
    const { encodeStreamCursor } = require("@/app/lib/stream-cursor") as typeof import("@/app/lib/stream-cursor");
    const { signToken } = require("@/app/lib/auth") as typeof import("@/app/lib/auth");
    const { getAdminAddress } = require("@/app/lib/admin-guard") as typeof import("@/app/lib/admin-guard");
    const { orgDb, _resetOrgDbForTesting } = require("@/app/lib/org-db") as typeof import("@/app/lib/org-db");

    const WALLET_SENDER_A = "GSENDERA000000000000000000000000000000000000000000000000";
    const WALLET_RECIP_W = "GRECIPIENTW000000000000000000000000000000000000000000000";
    const WALLET_OTHER = "GOTHERWALLET00000000000000000000000000000000000000000000";

    afterEach(() => {
      _resetOrgDbForTesting();
    });

    function seedTwoTenants() {
      clearStreams();
      const store = getStore().streamRepository.streams;

      for (let i = 1; i <= 3; i++) {
        store.set(`tenant-a-stream-${i}`, {
          id: `tenant-a-stream-${i}`,
          tenantId: "tenant-a",
          senderAddress: WALLET_SENDER_A,
          recipient: i === 2 ? WALLET_RECIP_W : WALLET_OTHER,
          rate: `${i * 10}`,
          schedule: "month",
          status: "active",
          nextAction: "pause",
          createdAt: `2026-03-0${i}T00:00:00.000Z`,
          updatedAt: `2026-03-0${i}T00:00:00.000Z`,
          token: "XLM",
          email: `user-${i}@tenant-a.test`,
          label: `Tenant A Stream ${i}`,
          memo: `Memo A-${i}`,
          partnerId: `PARTNER-A-${i}`,
        });

        store.set(`tenant-b-stream-${i}`, {
          id: `tenant-b-stream-${i}`,
          tenantId: "tenant-b",
          senderAddress: WALLET_OTHER,
          recipient: WALLET_RECIP_W,
          rate: `${i * 20}`,
          schedule: "month",
          status: "active",
          nextAction: "pause",
          createdAt: `2026-03-0${i}T00:00:00.000Z`,
          updatedAt: `2026-03-0${i}T00:00:00.000Z`,
          token: "XLM",
          email: `user-${i}@tenant-b.test`,
          label: `Tenant B Stream ${i}`,
          memo: `Memo B-${i}`,
          partnerId: `PARTNER-B-${i}`,
        });
      }
    }

    it("Row 1: Two tenants with 3 streams each; tenant A lists -> 3 streams, total: 3", async () => {
      seedTwoTenants();

      const v1Res = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: { "x-tenant-id": "tenant-a" },
        }),
      );
      expect(v1Res.status).toBe(200);
      const v1Body = await v1Res.json();
      expect(v1Body.data).toHaveLength(3);
      expect(v1Body.meta.total).toBe(3);
      expect(v1Body.data.map((s: Stream) => s.id)).toEqual([
        "tenant-a-stream-1",
        "tenant-a-stream-2",
        "tenant-a-stream-3",
      ]);

      const v2Res = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: "Bearer opaque-token",
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      expect(v2Res.status).toBe(200);
      const v2Body = await v2Res.json();
      expect(v2Body.streams).toHaveLength(3);
      expect(v2Body.meta.total).toBe(3);
    });

    it("Row 2: Wallet W is the recipient on 1 of A's streams -> W sees 1", async () => {
      seedTwoTenants();

      const v1Res = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": WALLET_RECIP_W,
          },
        }),
      );
      expect(v1Res.status).toBe(200);
      const v1Body = await v1Res.json();
      expect(v1Body.data).toHaveLength(1);
      expect(v1Body.data[0].id).toBe("tenant-a-stream-2");
      expect(v1Body.meta.total).toBe(1);

      const jwt = signToken(WALLET_RECIP_W);
      const v2Res = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: `Bearer ${jwt}`,
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      expect(v2Res.status).toBe(200);
      const v2Body = await v2Res.json();
      expect(v2Body.streams).toHaveLength(1);
      expect(v2Body.streams[0].id).toBe("tenant-a-stream-2");
      expect(v2Body.meta.total).toBe(1);
    });

    it("Row 2b: Org member of the owning org sees the org's stream in the tenant", async () => {
      seedTwoTenants();
      orgDb.streamOwnership.set("tenant-a-stream-3", "org-acme");
      const acmeMemberWallet = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";

      const res = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": acmeMemberWallet,
          },
        }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.map((s: Stream) => s.id)).toEqual(["tenant-a-stream-3"]);
      expect(body.meta.total).toBe(1);
    });

    it("Row 3: Admin sees all of the tenant's streams (and none of another tenant's)", async () => {
      seedTwoTenants();
      const adminWallet = getAdminAddress();

      const v1Res = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": adminWallet,
          },
        }),
      );
      expect(v1Res.status).toBe(200);
      const v1Body = await v1Res.json();
      expect(v1Body.data).toHaveLength(3);
      expect(v1Body.meta.total).toBe(3);

      const adminJwt = signToken("GADMIN_CUSTOM", { role: "admin" });
      const v2Res = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: `Bearer ${adminJwt}`,
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      expect(v2Res.status).toBe(200);
      const v2Body = await v2Res.json();
      expect(v2Body.streams).toHaveLength(3);
      expect(v2Body.meta.total).toBe(3);
    });

    it("Row 4: Unauthenticated v1 is tenant-scoped and PII fields (email, label, memo, partnerId) are absent", async () => {
      seedTwoTenants();

      const unauthRes = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: { "x-tenant-id": "tenant-a" },
        }),
      );
      expect(unauthRes.status).toBe(200);
      const unauthBody = await unauthRes.json();
      expect(unauthBody.data).toHaveLength(3);

      for (const stream of unauthBody.data) {
        expect(stream).not.toHaveProperty("email");
        expect(stream).not.toHaveProperty("label");
        expect(stream).not.toHaveProperty("memo");
        expect(stream).not.toHaveProperty("partnerId");
      }

      // Authenticated caller on v1 retains PII fields on streams they own
      const authRes = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": WALLET_SENDER_A,
          },
        }),
      );
      const authBody = await authRes.json();
      expect(authBody.data[0].email).toBe("user-1@tenant-a.test");
      expect(authBody.data[0].label).toBe("Tenant A Stream 1");
      expect(authBody.data[0].memo).toBe("Memo A-1");
      expect(authBody.data[0].partnerId).toBe("PARTNER-A-1");
    });

    it("Row 5: v2 meta.total equals the filtered count even when paginated", async () => {
      seedTwoTenants();

      const v2Res = await listStreamsV2(
        new Request("http://localhost/api/v2/streams?limit=1", {
          headers: {
            authorization: `Bearer ${signToken(WALLET_SENDER_A)}`,
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      expect(v2Res.status).toBe(200);
      const v2Body = await v2Res.json();
      expect(v2Body.streams).toHaveLength(1);
      expect(v2Body.meta.total).toBe(3);
      expect(v2Body.meta.hasNext).toBe(true);
    });

    it("Row 6: Cursor to an invisible stream is treated as unknown (422 INVALID_CURSOR) with no leak", async () => {
      seedTwoTenants();
      const invisibleStream = getStore().streamRepository.streams.get("tenant-b-stream-1")!;

      const legacyCursor = Buffer.from(invisibleStream.id).toString("base64");
      const keysetCursor = encodeStreamCursor(invisibleStream);

      for (const cursor of [legacyCursor, keysetCursor]) {
        const v1Res = await listStreams(
          new Request(`http://localhost/api/streams?cursor=${encodeURIComponent(cursor)}`, {
            headers: { "x-tenant-id": "tenant-a" },
          }),
        );
        expect(v1Res.status).toBe(422);
        const v1Body = await v1Res.json();
        expect(v1Body.error.code).toBe("INVALID_CURSOR");

        const v2Res = await listStreamsV2(
          new Request(`http://localhost/api/v2/streams?cursor=${encodeURIComponent(cursor)}`, {
            headers: {
              authorization: "Bearer test-token",
              "x-tenant-id": "tenant-a",
            },
          }),
        );
        expect(v2Res.status).toBe(422);
        const v2Body = await v2Res.json();
        expect(v2Body.error.code).toBe("INVALID_CURSOR");
      }

      // Also check cursor to a same-tenant stream not owned by the caller
      const sameTenantInvisible = getStore().streamRepository.streams.get("tenant-a-stream-1")!;
      const sameTenantCursor = encodeStreamCursor(sameTenantInvisible);
      const wRes = await listStreams(
        new Request(`http://localhost/api/streams?cursor=${encodeURIComponent(sameTenantCursor)}`, {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": WALLET_RECIP_W,
          },
        }),
      );
      expect(wRes.status).toBe(422);
      const wBody = await wRes.json();
      expect(wBody.error.code).toBe("INVALID_CURSOR");
    });

    it("Row 7: ETag for two different callers who see different lists differs", async () => {
      seedTwoTenants();

      const senderRes = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": WALLET_SENDER_A,
          },
        }),
      );
      const recipientRes = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: {
            "x-tenant-id": "tenant-a",
            "Actor-Wallet-Address": WALLET_RECIP_W,
          },
        }),
      );
      const unauthRes = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: { "x-tenant-id": "tenant-a" },
        }),
      );

      const senderEtag = senderRes.headers.get("etag");
      const recipientEtag = recipientRes.headers.get("etag");
      const unauthEtag = unauthRes.headers.get("etag");

      expect(senderEtag).toBeTruthy();
      expect(recipientEtag).toBeTruthy();
      expect(unauthEtag).toBeTruthy();
      expect(senderEtag).not.toBe(recipientEtag);
      // Sender (authenticated, includes PII) vs unauthenticated (PII redacted) also get different ETags
      expect(senderEtag).not.toBe(unauthEtag);

      // Same check on v2
      const v2SenderRes = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: `Bearer ${signToken(WALLET_SENDER_A)}`,
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      const v2RecipientRes = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: `Bearer ${signToken(WALLET_RECIP_W)}`,
            "x-tenant-id": "tenant-a",
          },
        }),
      );
      expect(v2SenderRes.headers.get("etag")).toBeTruthy();
      expect(v2SenderRes.headers.get("etag")).not.toBe(v2RecipientRes.headers.get("etag"));
    });

    it("Row 9: Ordering with ties on createdAt is stable by id ascending", async () => {
      clearStreams();
      const tiedTimestamp = "2026-04-01T12:00:00.000Z";
      for (const id of ["stream-tie-c", "stream-tie-a", "stream-tie-b"]) {
        getStore().streamRepository.streams.set(id, {
          id,
          tenantId: "tenant-tie",
          senderAddress: WALLET_SENDER_A,
          recipient: WALLET_RECIP_W,
          rate: "10",
          schedule: "month",
          status: "active",
          nextAction: "pause",
          createdAt: tiedTimestamp,
          updatedAt: tiedTimestamp,
          token: "XLM",
        });
      }

      const v1Res = await listStreams(
        new Request("http://localhost/api/streams", {
          headers: { "x-tenant-id": "tenant-tie" },
        }),
      );
      const v1Body = await v1Res.json();
      expect(v1Body.data.map((s: Stream) => s.id)).toEqual([
        "stream-tie-a",
        "stream-tie-b",
        "stream-tie-c",
      ]);

      const v2Res = await listStreamsV2(
        new Request("http://localhost/api/v2/streams", {
          headers: {
            authorization: "Bearer test-token",
            "x-tenant-id": "tenant-tie",
          },
        }),
      );
      const v2Body = await v2Res.json();
      expect(v2Body.streams.map((s: { id: string }) => s.id)).toEqual([
        "stream-tie-a",
        "stream-tie-b",
        "stream-tie-c",
      ]);
    });
  });
});