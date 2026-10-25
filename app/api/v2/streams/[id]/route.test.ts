/** @jest-environment node */
import { GET, DELETE } from "./route";
import { db, resetDb } from "@/app/lib/db";

describe("GET /api/v2/streams/:id - weak ETag and If-None-Match cache revalidation", () => {
  const streamId = "stream-ada";

  beforeEach(() => {
    resetDb();
  });

  it("returns 200 OK with stream data and ETag header on first request", async () => {
    const req = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
    });

    const res = await GET(req, { params: Promise.resolve({ id: streamId }) });
    expect(res.status).toBe(200);

    const etag = res.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toBe(`W/"2026-04-28T10:30:00Z"`); // Matches updatedAt of stream-ada in db.ts
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const body = await res.json();
    expect(body.data.id).toBe(streamId);
  });

  it("returns 304 Not Modified when request has matching If-None-Match weak ETag", async () => {
    const req = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
      headers: {
        "If-None-Match": `W/"2026-04-28T10:30:00Z"`,
      },
    });

    const res = await GET(req, { params: Promise.resolve({ id: streamId }) });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`W/"2026-04-28T10:30:00Z"`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    // A 304 response must not contain a body
    const text = await res.text();
    expect(text).toBe("");
  });

  it("returns 304 Not Modified when If-None-Match is '*' or contains matching ETag in list", async () => {
    const reqStar = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
      headers: {
        "If-None-Match": "*",
      },
    });
    const resStar = await GET(reqStar, { params: Promise.resolve({ id: streamId }) });
    expect(resStar.status).toBe(304);

    const reqList = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
      headers: {
        "If-None-Match": `W/"other-etag", W/"2026-04-28T10:30:00Z"`,
      },
    });
    const resList = await GET(reqList, { params: Promise.resolve({ id: streamId }) });
    expect(resList.status).toBe(304);
  });

  it("returns 200 OK and updates ETag when the stream's updatedAt timestamp changes", async () => {
    // 1. Get initial stream
    const stream = db.streams.get(streamId);
    expect(stream).toBeDefined();

    // 2. Perform request with the initial ETag -> 304 Not Modified
    const req1 = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
      headers: {
        "If-None-Match": `W/"${stream.updatedAt}"`,
      },
    });
    const res1 = await GET(req1, { params: Promise.resolve({ id: streamId }) });
    expect(res1.status).toBe(304);

    // 3. Update the stream's updatedAt timestamp in the database
    const updatedTime = "2026-05-01T12:00:00Z";
    db.streams.set(streamId, {
      ...stream,
      updatedAt: updatedTime,
    });

    // 4. Perform the same request with the old ETag -> 200 OK with the new ETag
    const req2 = new Request(`http://localhost/api/v2/streams/${streamId}`, {
      method: "GET",
      headers: {
        "If-None-Match": `W/"${stream.updatedAt}"`, // Old ETag
      },
    });
    const res2 = await GET(req2, { params: Promise.resolve({ id: streamId }) });
    expect(res2.status).toBe(200);
    expect(res2.headers.get("etag")).toBe(`W/"${updatedTime}"`);

    const body = await res2.json();
    expect(body.data.id).toBe(streamId);
  });

  it("returns 404 Not Found if the stream does not exist", async () => {
    const req = new Request(`http://localhost/api/v2/streams/non-existent`, {
      method: "GET",
    });

    const res = await GET(req, { params: Promise.resolve({ id: "non-existent" }) });
    expect(res.status).toBe(404);
  });

  describe("DELETE /api/v2/streams/:id - V2 deletion guards and parity", () => {
    const sender = "GSENDER_V2_TEST_12345";
    const nonSender = "GSTRANGER_V2_TEST_99999";

    it("returns 409 FUNDS_PENDING_WITHDRAWAL when stream status is ended", async () => {
      const targetId = "stream-v2-ended";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "ended",
        withdrawal: { state: "pending", requestedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), attempts: 1 },
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: targetId }) });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe("FUNDS_PENDING_WITHDRAWAL");
    });

    it("returns 204 when deleting draft stream as sender", async () => {
      const targetId = "stream-v2-draft";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: targetId }) });
      expect(res.status).toBe(204);

      // Subsequent GET returns 404
      const getRes = await GET(new Request(`http://localhost/api/v2/streams/${targetId}`), {
        params: Promise.resolve({ id: targetId }),
      });
      expect(getRes.status).toBe(404);
    });

    it("returns 403 when deleting as non-sender", async () => {
      const targetId = "stream-v2-forbidden";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": nonSender },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: targetId }) });
      expect(res.status).toBe(403);
    });

    it("returns 204 when deleting withdrawn with succeeded status", async () => {
      const targetId = "stream-v2-withdrawn";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "withdrawn",
        withdrawal: { state: "succeeded", requestedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), attempts: 1 },
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: targetId }) });
      expect(res.status).toBe(204);
    });

    it("is idempotent: returns 204 on second delete", async () => {
      const targetId = "stream-v2-idempotent";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req1 = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res1 = await DELETE(req1, { params: Promise.resolve({ id: targetId }) });
      expect(res1.status).toBe(204);

      const req2 = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res2 = await DELETE(req2, { params: Promise.resolve({ id: targetId }) });
      expect(res2.status).toBe(204);
    });

    it("returns 404 for unknown stream ID", async () => {
      const req = new Request(`http://localhost/api/v2/streams/stream-unknown-v2`, {
        method: "DELETE",
        headers: { "Actor-Wallet-Address": sender },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: "stream-unknown-v2" }) });
      expect(res.status).toBe(404);
    });

    it("records stream.delete audit entry with before snapshot on v2 delete", async () => {
      const { auditLogStore, resetAuditLogStore } = await import("@/app/lib/audit-log");
      resetAuditLogStore();

      const targetId = "stream-v2-audit-check";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const req = new Request(`http://localhost/api/v2/streams/${targetId}`, {
        method: "DELETE",
        headers: {
          "Actor-Wallet-Address": sender,
          "x-request-id": "req-v2-delete-audit",
        },
      });
      const res = await DELETE(req, { params: Promise.resolve({ id: targetId }) });
      expect(res.status).toBe(204);

      const entries = auditLogStore.list({ requestId: "req-v2-delete-audit" });
      expect(entries.length).toBe(1);
      expect(entries[0].action).toBe("stream.delete");
      expect(entries[0].before).toBeDefined();
      expect((entries[0].before as any).id).toBe(targetId);
      expect((entries[0].before as any).status).toBe("draft");
    });

    it("returns 404 (not 304) on GET with stale If-None-Match after v2 delete", async () => {
      const targetId = "stream-v2-stale-etag";
      const updatedAt = "2026-04-28T10:30:00Z";
      db.streams.set(targetId, {
        id: targetId,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: "2026-04-01T09:00:00Z",
        updatedAt,
        token: "XLM",
      } as any);

      const initialGet = await GET(new Request(`http://localhost/api/v2/streams/${targetId}`), {
        params: Promise.resolve({ id: targetId }),
      });
      expect(initialGet.status).toBe(200);
      const etag = initialGet.headers.get("etag")!;

      const delRes = await DELETE(
        new Request(`http://localhost/api/v2/streams/${targetId}`, {
          method: "DELETE",
          headers: { "Actor-Wallet-Address": sender },
        }),
        { params: Promise.resolve({ id: targetId }) }
      );
      expect(delRes.status).toBe(204);

      const replayGet = await GET(
        new Request(`http://localhost/api/v2/streams/${targetId}`, {
          headers: { "If-None-Match": etag },
        }),
        { params: Promise.resolve({ id: targetId }) }
      );
      expect(replayGet.status).toBe(404);
      expect(replayGet.status).not.toBe(304);
    });
  });
});
