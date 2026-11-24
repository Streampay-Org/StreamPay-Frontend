/** @jest-environment node */
import { deleteStream } from "./stream-delete";
import { db, resetDb } from "./db";
import { auditLogStore, resetAuditLogStore } from "./audit-log";
import { streamCache } from "./cache";
import { orgDb } from "./org-db";

describe("deleteStream helper coverage", () => {
  const tenantId = "org-acme";
  const sender = "GSENDER_HELPER_TEST_12345";
  const nonSender = "GSTRANGER_HELPER_TEST_99999";
  const orgOwner = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW"; // org-acme owner

  beforeEach(() => {
    resetDb();
    resetAuditLogStore();
  });

  it("returns 404 STREAM_NOT_FOUND when stream does not exist", async () => {
    const res = await deleteStream("non-existent-id", { walletAddress: sender });
    expect(res.success).toBe(false);
    expect(res.status).toBe(404);
    expect((res as any).code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 204 idempotently when stream is already soft-deleted", async () => {
    const id = "stream-already-deleted";
    db.streams.set(id, {
      id,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      deletedAt: new Date().toISOString(),
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { walletAddress: sender }, tenantId);
    expect(res.success).toBe(true);
    expect(res.status).toBe(204);
  });

  it("returns 404 when tenant mismatches stream tenant", async () => {
    const id = "stream-tenant-mismatch";
    db.streams.set(id, {
      id,
      tenant: "org-other",
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { walletAddress: sender }, "org-acme");
    expect(res.success).toBe(false);
    expect(res.status).toBe(404);
    expect((res as any).code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 403 FORBIDDEN when actor is not sender or org owner", async () => {
    const id = "stream-forbidden-check";
    db.streams.set(id, {
      id,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { walletAddress: nonSender }, tenantId);
    expect(res.success).toBe(false);
    expect(res.status).toBe(403);
    expect((res as any).code).toBe("FORBIDDEN");
  });

  it("allows delete when actor is an org owner", async () => {
    const id = "stream-org-owner-ok";
    db.streams.set(id, {
      id,
      tenant: "org-acme",
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { walletAddress: orgOwner }, "org-acme");
    expect(res.success).toBe(true);
    expect(res.status).toBe(204);
  });

  it("returns 409 FUNDS_PENDING_WITHDRAWAL when status is ended", async () => {
    const id = "stream-ended-deletable-check";
    db.streams.set(id, {
      id,
      tenant: tenantId,
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

    const res = await deleteStream(id, { walletAddress: sender }, tenantId);
    expect(res.success).toBe(false);
    expect(res.status).toBe(409);
    expect((res as any).code).toBe("FUNDS_PENDING_WITHDRAWAL");
  });

  it("returns 409 STREAM_INACTIVE_STATE when status is active or paused", async () => {
    const idActive = "stream-active-check";
    db.streams.set(idActive, {
      id: idActive,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "active",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const resActive = await deleteStream(idActive, { walletAddress: sender }, tenantId);
    expect(resActive.success).toBe(false);
    expect(resActive.status).toBe(409);
    expect((resActive as any).code).toBe("STREAM_INACTIVE_STATE");

    const idPaused = "stream-paused-check";
    db.streams.set(idPaused, {
      id: idPaused,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "paused",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const resPaused = await deleteStream(idPaused, { walletAddress: sender }, tenantId);
    expect(resPaused.success).toBe(false);
    expect(resPaused.status).toBe(409);
    expect((resPaused as any).code).toBe("STREAM_INACTIVE_STATE");
  });

  it("returns 409 when status is withdrawn but withdrawal state is pending or failed", async () => {
    const id = "stream-withdrawn-pending";
    db.streams.set(id, {
      id,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "withdrawn",
      withdrawal: { state: "pending", requestedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), attempts: 1 },
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { walletAddress: sender }, tenantId);
    expect(res.success).toBe(false);
    expect(res.status).toBe(409);
    expect((res as any).code).toBe("STREAM_INACTIVE_STATE");
  });

  it("allows delete of cancelled stream and records audit event", async () => {
    const id = "stream-cancelled-ok";
    db.streams.set(id, {
      id,
      tenant: tenantId,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "cancelled",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const mockReq = new Request(`http://localhost/api/streams/${id}`, {
      method: "DELETE",
      headers: {
        "x-tenant-id": tenantId,
        "Actor-Wallet-Address": sender,
        "x-request-id": "req-cancelled-audit-check",
      },
    });

    const res = await deleteStream(id, { walletAddress: sender }, tenantId, mockReq);
    expect(res.success).toBe(true);
    expect(res.status).toBe(204);

    const updated = db.streams.get(id);
    expect((updated as any).deletedAt).toBeDefined();

    const auditEntries = auditLogStore.list({ requestId: "req-cancelled-audit-check" });
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].action).toBe("stream.delete");
    expect(auditEntries[0].before).toBeDefined();
    expect((auditEntries[0].before as any).status).toBe("cancelled");
  });

  it("allows delete when actor is null (v2 unauthenticated scenario)", async () => {
    const id = "stream-v2-no-actor";
    db.streams.set(id, {
      id,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, null, null);
    expect(res.success).toBe(true);
    expect(res.status).toBe(204);
  });

  it("resolves actor via actorId and checks orgDb.streamOwnership", async () => {
    const id = "stream-org-ownership-map";
    orgDb.streamOwnership.set(id, "org-acme");
    db.streams.set(id, {
      id,
      senderAddress: sender,
      recipient: "GRECIPIENT",
      status: "draft",
      rate: "10 XLM",
      schedule: "month",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
    } as any);

    const res = await deleteStream(id, { actorId: orgOwner });
    expect(res.success).toBe(true);
    expect(res.status).toBe(204);
  });

  it("handles unset STELLAR_NETWORK fallback to default", async () => {
    const prev = process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_NETWORK;
    try {
      const id = "stream-network-fallback";
      db.streams.set(id, {
        id,
        senderAddress: sender,
        recipient: "GRECIPIENT",
        status: "draft",
        rate: "10 XLM",
        schedule: "month",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        token: "XLM",
      } as any);

      const res = await deleteStream(id, { walletAddress: sender });
      expect(res.success).toBe(true);
      expect(res.status).toBe(204);
    } finally {
      process.env.STELLAR_NETWORK = prev;
    }
  });
});
