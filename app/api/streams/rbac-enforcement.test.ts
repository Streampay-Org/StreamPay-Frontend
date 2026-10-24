/** @jest-environment node */

import { POST as startPOST } from "./[id]/start/route";
import { POST as pausePOST } from "./[id]/pause/route";
import { POST as stopPOST } from "./[id]/stop/route";
import { POST as settlePOST } from "./[id]/settle/route";
import { POST as withdrawPOST } from "./[id]/withdraw/route";
import { POST as batchStartPOST } from "./batch/start/route";
import { POST as batchStopPOST } from "./batch/stop/route";
import { db, resetDb } from "@/app/lib/db";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetAuditLogStore } from "@/app/lib/audit-log";
import { signToken } from "@/app/lib/auth";

// Org Acme member addresses from orgDb fixtures
const OWNER_ADDR = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const PAUSER_ADDR = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";
const SETTLER_ADDR = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const VIEWER_ADDR = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";

interface RouteHandlerSpec {
  name: string;
  isBatch: boolean;
  action: "start" | "pause" | "stop" | "settle" | "withdraw";
  allowedActor: string;
  viewerActor: string;
  mismatchActor: string;
  setupStream: (streamId: string) => void;
  invoke: (streamId: string, headers?: Record<string, string>) => Promise<Response>;
}

const routes: RouteHandlerSpec[] = [
  {
    name: "POST /api/streams/[id]/start",
    isBatch: false,
    action: "start",
    allowedActor: PAUSER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: SETTLER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "paused" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "paused",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost/api/streams/${id}/start`, {
        method: "POST",
        headers,
      });
      return startPOST(req as any, { params: Promise.resolve({ id }) });
    },
  },
  {
    name: "POST /api/streams/[id]/pause",
    isBatch: false,
    action: "pause",
    allowedActor: PAUSER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: SETTLER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "active" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "active",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost/api/streams/${id}/pause`, {
        method: "POST",
        headers,
      });
      return pausePOST(req as any, { params: Promise.resolve({ id }) });
    },
  },
  {
    name: "POST /api/streams/[id]/stop",
    isBatch: false,
    action: "stop",
    allowedActor: OWNER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: PAUSER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "active" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "active",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost/api/streams/${id}/stop`, {
        method: "POST",
        headers,
      });
      return stopPOST(req as any, { params: Promise.resolve({ id }) });
    },
  },
  {
    name: "POST /api/streams/[id]/settle",
    isBatch: false,
    action: "settle",
    allowedActor: SETTLER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: PAUSER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "active" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "active",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost/api/streams/${id}/settle`, {
        method: "POST",
        headers: { "Idempotency-Key": `key-settle-${Math.random()}`, ...headers },
      });
      return settlePOST(req as any, { params: Promise.resolve({ id }) });
    },
  },
  {
    name: "POST /api/streams/[id]/withdraw",
    isBatch: false,
    action: "withdraw",
    allowedActor: SETTLER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: PAUSER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, {
          ...stream,
          status: "ended",
          settlementTxHash: undefined,
          withdrawal: undefined,
        });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "ended",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
          settlementTxHash: undefined,
          withdrawal: undefined,
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request(`http://localhost/api/streams/${id}/withdraw`, {
        method: "POST",
        headers: { "Idempotency-Key": `key-withdraw-${Math.random()}`, ...headers },
      });
      return withdrawPOST(req as any, { params: Promise.resolve({ id }) });
    },
  },
  {
    name: "POST /api/streams/batch/start",
    isBatch: true,
    action: "start",
    allowedActor: PAUSER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: SETTLER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "draft" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "draft",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request("http://localhost/api/streams/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify([id]),
      });
      return batchStartPOST(req as any);
    },
  },
  {
    name: "POST /api/streams/batch/stop",
    isBatch: true,
    action: "stop",
    allowedActor: OWNER_ADDR,
    viewerActor: VIEWER_ADDR,
    mismatchActor: PAUSER_ADDR,
    setupStream: (id: string) => {
      const stream = db.streams.get(id);
      if (stream) {
        db.streams.set(id, { ...stream, status: "active" });
      } else {
        db.streams.set(id, {
          id,
          recipient: "GRECIPIENT00000000000000000000000000000000000000000",
          rate: "10 XLM / day",
          status: "active",
          token: "XLM",
          senderAddress: "GSENDER00000000000000000000000000000000000000000000",
        } as any);
      }
    },
    invoke: (id: string, headers: Record<string, string> = {}) => {
      const req = new Request("http://localhost/api/streams/batch/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify([id]),
      });
      return batchStopPOST(req as any);
    },
  },
];

describe("Stream Lifecycle Org-RBAC Enforcement (Table-Driven)", () => {
  const originalEnv = process.env.STREAMPAY_ALLOW_ACTOR_HEADER;
  const ORG_STREAM = "stream-ada";
  const INDIV_STREAM = "stream-kemi";

  beforeEach(() => {
    resetDb();
    _resetOrgDbForTesting();
    resetRateLimitStore();
    resetAuditLogStore();
    process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "true";

    // Ensure org-acme policy has requireApprovals = 1 for the direct execution test cases
    const acme = orgDb.orgs.get("org-acme");
    if (acme) {
      acme.policy.requireApprovals = 1;
    }
  });

  afterAll(() => {
    if (originalEnv !== undefined) {
      process.env.STREAMPAY_ALLOW_ACTOR_HEADER = originalEnv;
    } else {
      delete process.env.STREAMPAY_ALLOW_ACTOR_HEADER;
    }
  });

  describe.each(routes)("$name", (route) => {
    beforeEach(() => {
      route.setupStream(ORG_STREAM);
      route.setupStream(INDIV_STREAM);
    });

    // ── Scenario 1 ───────────────────────────────────────────────────────────
    it("Scenario 1: Org-owned stream, no JWT, no header -> 403 ACTOR_REQUIRED; state unchanged", async () => {
      const initialStatus = db.streams.get(ORG_STREAM)?.status;
      const res = await route.invoke(ORG_STREAM, {});
      const body = await res.json();

      if (route.isBatch) {
        expect(res.status).toBe(422);
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details).toHaveLength(1);
        expect(body.error.details[0].code).toBe("ACTOR_REQUIRED");
      } else {
        expect(res.status).toBe(403);
        expect(body.error.code).toBe("ACTOR_REQUIRED");
      }

      // Verify stream state is completely unchanged
      expect(db.streams.get(ORG_STREAM)?.status).toBe(initialStatus);
    });

    // ── Scenario 2 ───────────────────────────────────────────────────────────
    it("Scenario 2: Org-owned, JWT of a member with permission -> 200", async () => {
      const token = signToken(route.allowedActor);
      const res = await route.invoke(ORG_STREAM, {
        Authorization: `Bearer ${token}`,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
    });

    // ── Scenario 3 ───────────────────────────────────────────────────────────
    it("Scenario 3: Org-owned, JWT of a viewer -> 403 ROLE_INSUFFICIENT", async () => {
      const token = signToken(route.viewerActor);
      const res = await route.invoke(ORG_STREAM, {
        Authorization: `Bearer ${token}`,
      });
      const body = await res.json();

      if (route.isBatch) {
        expect(res.status).toBe(422);
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details[0].code).toBe("ROLE_INSUFFICIENT");
      } else {
        expect(res.status).toBe(403);
        expect(body.error.code).toBe("ROLE_INSUFFICIENT");
      }
    });

    // ── Scenario 4 ───────────────────────────────────────────────────────────
    it("Scenario 4: JWT and a header that differ -> 403 ACTOR_MISMATCH", async () => {
      const token = signToken(route.allowedActor);
      const res = await route.invoke(ORG_STREAM, {
        Authorization: `Bearer ${token}`,
        "Actor-Wallet-Address": route.mismatchActor,
      });
      const body = await res.json();

      if (route.isBatch) {
        expect(res.status).toBe(422);
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details[0].code).toBe("ACTOR_MISMATCH");
      } else {
        expect(res.status).toBe(403);
        expect(body.error.code).toBe("ACTOR_MISMATCH");
      }
    });

    // ── Scenario 5 ───────────────────────────────────────────────────────────
    it("Scenario 5: Header only, flag false -> 403 ACTOR_REQUIRED", async () => {
      process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "false";
      const res = await route.invoke(ORG_STREAM, {
        "Actor-Wallet-Address": route.allowedActor,
      });
      const body = await res.json();

      if (route.isBatch) {
        expect(res.status).toBe(422);
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details[0].code).toBe("ACTOR_REQUIRED");
      } else {
        expect(res.status).toBe(403);
        expect(body.error.code).toBe("ACTOR_REQUIRED");
      }
    });

    // ── Scenario 6 ───────────────────────────────────────────────────────────
    it("Scenario 6: Header only, flag true (test env) -> Policy evaluated as today (200)", async () => {
      process.env.STREAMPAY_ALLOW_ACTOR_HEADER = "true";
      const res = await route.invoke(ORG_STREAM, {
        "Actor-Wallet-Address": route.allowedActor,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
    });

    // ── Scenario 7 ───────────────────────────────────────────────────────────
    it("Scenario 7: Individually owned stream, no actor -> Unchanged behaviour (200)", async () => {
      const res = await route.invoke(INDIV_STREAM, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBeDefined();
    });

    // ── Scenario 9 ───────────────────────────────────────────────────────────
    it("Scenario 9: Error body includes request_id", async () => {
      const customRequestId = "req_trace_rbac_test_12345";
      const res = await route.invoke(ORG_STREAM, {
        "x-request-id": customRequestId,
      });

      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.request_id).toBeDefined();
      expect(typeof body.error.request_id).toBe("string");
      expect(body.error.request_id.length).toBeGreaterThan(0);
    });
  });

  // ── Scenario 8: Batch with one forbidden id ─────────────────────────────────
  describe("Scenario 8: Batch dry-run atomicity with one forbidden stream id", () => {
    it("POST /api/streams/batch/start: rejects all-or-nothing with 422 naming failing index", async () => {
      // stream-kemi is draft (individually owned, valid)
      // stream-ada is org-owned (requires actor, forbidden without token)
      db.streams.set("stream-kemi", { ...db.streams.get("stream-kemi")!, status: "draft" });
      db.streams.set("stream-ada", { ...db.streams.get("stream-ada")!, status: "draft" });

      const req = new Request("http://localhost/api/streams/batch/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["stream-kemi", "stream-ada"]),
      });

      const res = await batchStartPOST(req as any);
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toBeDefined();

      const failedItem = body.error.details.find((d: any) => d.id === "stream-ada");
      expect(failedItem).toBeDefined();
      expect(failedItem.index).toBe(1);
      expect(failedItem.code).toBe("ACTOR_REQUIRED");

      // No writes: stream-kemi must remain in draft
      expect(db.streams.get("stream-kemi")?.status).toBe("draft");
      expect(db.streams.get("stream-ada")?.status).toBe("draft");
    });

    it("POST /api/streams/batch/stop: rejects all-or-nothing with 422 naming failing index", async () => {
      // Seed indiv stream with active status
      db.streams.set("stream-indiv-active", {
        ...db.streams.get("stream-kemi")!,
        id: "stream-indiv-active",
        status: "active",
      });
      db.streams.set("stream-ada", { ...db.streams.get("stream-ada")!, status: "active" });

      const req = new Request("http://localhost/api/streams/batch/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["stream-indiv-active", "stream-ada"]),
      });

      const res = await batchStopPOST(req as any);
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toBeDefined();

      const failedItem = body.error.details.find((d: any) => d.id === "stream-ada");
      expect(failedItem).toBeDefined();
      expect(failedItem.index).toBe(1);
      expect(failedItem.code).toBe("ACTOR_REQUIRED");

      // No writes: stream-indiv-active must remain active
      expect(db.streams.get("stream-indiv-active")?.status).toBe("active");
      expect(db.streams.get("stream-ada")?.status).toBe("active");
    });
  });

  // ── Regression proof ────────────────────────────────────────────────────────
  describe("Regression Proof: Pause, stop, and settle no longer return 200 without actor", () => {
    it("pause returns 403 ACTOR_REQUIRED instead of 200 on unauthenticated call", async () => {
      db.streams.set(ORG_STREAM, { ...db.streams.get(ORG_STREAM)!, status: "active" });
      const req = new Request(`http://localhost/api/streams/${ORG_STREAM}/pause`, { method: "POST" });
      const res = await pausePOST(req as any, { params: Promise.resolve({ id: ORG_STREAM }) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("ACTOR_REQUIRED");
      expect(db.streams.get(ORG_STREAM)?.status).toBe("active");
    });

    it("stop returns 403 ACTOR_REQUIRED instead of 200 on unauthenticated call", async () => {
      db.streams.set(ORG_STREAM, { ...db.streams.get(ORG_STREAM)!, status: "active" });
      const req = new Request(`http://localhost/api/streams/${ORG_STREAM}/stop`, { method: "POST" });
      const res = await stopPOST(req as any, { params: Promise.resolve({ id: ORG_STREAM }) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("ACTOR_REQUIRED");
      expect(db.streams.get(ORG_STREAM)?.status).toBe("active");
    });

    it("settle returns 403 ACTOR_REQUIRED instead of 200 on unauthenticated call", async () => {
      db.streams.set(ORG_STREAM, { ...db.streams.get(ORG_STREAM)!, status: "active" });
      const req = new Request(`http://localhost/api/streams/${ORG_STREAM}/settle`, {
        method: "POST",
        headers: { "Idempotency-Key": "regression-settle-key" },
      });
      const res = await settlePOST(req as any, { params: Promise.resolve({ id: ORG_STREAM }) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("ACTOR_REQUIRED");
      expect(db.streams.get(ORG_STREAM)?.status).toBe("active");
    });
  });
});
