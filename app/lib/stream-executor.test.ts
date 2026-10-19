/**
 * @jest-environment node
 *
 * stream-executor.test.ts — Unit tests for executeStreamAction
 *
 * Verifies all actions (start, pause, stop, settle, withdraw), state guards,
 * invalid states, audit trails (with approvalId), and Stellar error handling.
 */

import { executeStreamAction } from "./stream-executor";
import { db, resetDb } from "./db";
import { auditLogStore, resetAuditLogStore } from "./audit-log";
import { Stream } from "@/app/types/openapi";

describe("executeStreamAction", () => {
  beforeEach(() => {
    resetDb();
    resetAuditLogStore();
    delete (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__;
  });

  afterEach(() => {
    delete (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__;
  });

  it("returns 404 STREAM_NOT_FOUND when stream does not exist", async () => {
    const res = await executeStreamAction("non-existent-stream", "pause");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(404);
      expect(res.code).toBe("STREAM_NOT_FOUND");
    }
  });

  it("fails with UNKNOWN_ACTION for invalid action", async () => {
    const res = await executeStreamAction("stream-ada", "invalid-action" as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.code).toBe("UNKNOWN_ACTION");
    }
  });

  describe("start action", () => {
    it("starts a draft stream to active", async () => {
      const res = await executeStreamAction("stream-kemi", "start");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("active");
        expect(res.stream.nextAction).toBe("pause");
      }
    });

    it("resumes a paused stream to active and clears pausedAt", async () => {
      const stream = db.streams.get("stream-ada")!;
      db.streams.set("stream-ada", { ...stream, status: "paused", pausedAt: "2026-01-01T00:00:00Z" });

      const res = await executeStreamAction("stream-ada", "resume");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("active");
        expect(res.stream.pausedAt).toBeUndefined();
      }
    });

    it("fails with INVALID_STREAM_STATE when starting an ended stream", async () => {
      const res = await executeStreamAction("stream-yusuf", "start");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.code).toBe("INVALID_STREAM_STATE");
      }
    });
  });

  describe("pause action", () => {
    it("pauses an active stream and records audit log with approvalId", async () => {
      const res = await executeStreamAction("stream-ada", "pause", {
        actor: "GACTOR123",
        approvalId: "appr-123",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("paused");
        expect(res.stream.pausedAt).toBeDefined();
        expect(res.stream.nextAction).toBe("stop");
      }

      const auditEvents = auditLogStore.list().filter((e) => e.target.id === "stream-ada");
      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0].action).toBe("stream.pause");
      expect(auditEvents[0].metadata?.approvalId).toBe("appr-123");
    });

    it("fails with INVALID_STREAM_STATE when pausing a non-active stream", async () => {
      const res = await executeStreamAction("stream-kemi", "pause");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.code).toBe("INVALID_STREAM_STATE");
      }
    });
  });

  describe("stop action", () => {
    it("stops an active stream and records audit log", async () => {
      const res = await executeStreamAction("stream-ada", "stop", {
        actor: "GACTOR123",
        approvalId: "appr-456",
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("ended");
        expect(res.stream.nextAction).toBe("withdraw");
      }

      const auditEvents = auditLogStore.list().filter((e) => e.target.id === "stream-ada");
      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0].action).toBe("stream.stop.override");
      expect(auditEvents[0].metadata?.approvalId).toBe("appr-456");
    });

    it("stops a draft stream successfully", async () => {
      const res = await executeStreamAction("stream-kemi", "stop");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.stream.status).toBe("ended");
      }
    });

    it("fails with INVALID_STREAM_STATE when stopping an already ended stream", async () => {
      const res = await executeStreamAction("stream-yusuf", "stop");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.code).toBe("INVALID_STREAM_STATE");
      }
    });
  });

  describe("settle action", () => {
    it("settles an active stream with Stellar settlement client", async () => {
      (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
        settleStream: jest.fn().mockResolvedValue({ txHash: "tx-test-hash", settledAt: new Date().toISOString() }),
      };

      const res = await executeStreamAction("stream-ada", "settle", {
        actor: "GACTOR123",
        approvalId: "appr-settle",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("ended");
        expect(res.stream.settlementTxHash).toBeDefined();
        expect(res.data.settlement.txHash).toBe("tx-test-hash");
      }

      const auditEvents = auditLogStore.list().filter((e) => e.target.id === "stream-ada");
      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0].action).toBe("stream.settle");
      expect(auditEvents[0].metadata?.approvalId).toBe("appr-settle");
    });

    it("settles a paused stream successfully", async () => {
      const stream = db.streams.get("stream-ada")!;
      db.streams.set("stream-ada", { ...stream, status: "paused" });

      (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
        settleStream: jest.fn().mockResolvedValue({ txHash: "tx-paused-hash", settledAt: new Date().toISOString() }),
      };

      const res = await executeStreamAction("stream-ada", "settle");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.stream.status).toBe("ended");
      }
    });

    it("returns 502 SETTLEMENT_FAILED when Stellar settlement client rejects", async () => {
      (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
        settleStream: jest.fn().mockRejectedValue(new Error("Stellar RPC timeout")),
      };

      const res = await executeStreamAction("stream-ada", "settle");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(502);
        expect(res.code).toBe("SETTLEMENT_FAILED");
      }

      // Stream status unchanged
      expect(db.streams.get("stream-ada")?.status).toBe("active");
    });

    it("fails with INVALID_STREAM_STATE when settling a draft stream", async () => {
      const res = await executeStreamAction("stream-kemi", "settle");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.code).toBe("INVALID_STREAM_STATE");
      }
    });
  });

  describe("withdraw action", () => {
    it("withdraws an ended stream", async () => {
      resetAuditLogStore();
      const res = await executeStreamAction("stream-yusuf", "withdraw", {
        actor: "GACTOR123",
        approvalId: "appr-withdraw",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
      }

      const auditEvents = auditLogStore.list().filter((e) => e.target.id === "stream-yusuf" && e.action === "stream.withdraw");
      expect(auditEvents.length).toBe(1);
      expect(auditEvents[0].action).toBe("stream.withdraw");
      expect(auditEvents[0].metadata?.approvalId).toBe("appr-withdraw");
    });

    it("short circuits with 200 when stream is already withdrawn", async () => {
      const stream = db.streams.get("stream-yusuf")!;
      db.streams.set("stream-yusuf", { ...stream, status: "withdrawn" });

      const res = await executeStreamAction("stream-yusuf", "withdraw");
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe(200);
        expect(res.stream.status).toBe("withdrawn");
      }
    });

    it("fails with INVALID_STREAM_STATE when withdrawing an active stream", async () => {
      const res = await executeStreamAction("stream-ada", "withdraw");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.code).toBe("INVALID_STREAM_STATE");
      }
    });
  });
});
