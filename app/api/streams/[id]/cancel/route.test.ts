/**
 * @jest-environment node
 *
 * Route tests for POST /api/streams/:id/cancel
 *
 * Implements verification for issue #1731
 */

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  extractCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
  withCorrelationContext: jest.fn((_ctx: any, cb: any) => cb()),
  setCorrelationContext: jest.fn(),
}));

import { POST as cancelStream } from "./route";
import { POST as createStreamV1 } from "@/app/api/streams/route";
import { POST as createStreamV2 } from "@/app/api/v2/streams/route";
import { POST as createBatchStream } from "@/app/api/streams/batch/route";
import { POST as createImportStream } from "@/app/api/streams/import/route";
import { POST as createMultiStream } from "@/app/api/v2/streams/multi/route";

import { db, resetDb } from "@/app/lib/db";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { signToken } from "@/app/lib/auth";
import { DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import { NextRequest } from "next/server";

const WALLET_SENDER = "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H";
const WALLET_ATTACKER = "GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA";
const WALLET_RECIPIENT = "GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC";
const ORG_OWNER = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function cancelReq(
  id: string,
  opts: {
    jwt?: string | null;
    actorHeader?: string | null;
    idempotencyKey?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.jwt) {
    headers["Authorization"] = `Bearer ${opts.jwt}`;
  }
  if (opts.actorHeader) {
    headers["Actor-Wallet-Address"] = opts.actorHeader;
  }
  if (opts.idempotencyKey) {
    headers["Idempotency-Key"] = opts.idempotencyKey;
  }
  return new Request(`http://localhost/api/streams/${id}/cancel`, {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  resetDb();
  resetAuditLogStore();
  resetRateLimitStore();
  _resetOrgDbForTesting();
});

describe("POST /api/streams/:id/cancel — Issue #1731 Test Plan", () => {
  it("Row 1: Create with a JWT for GA...S, cancel with the same JWT -> 200, names GA...S as refund target", async () => {
    const senderToken = signToken(WALLET_SENDER);

    // 1. Create stream authenticated as WALLET_SENDER
    const createReq = new Request("http://localhost/api/streams", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify({
        recipient: WALLET_RECIPIENT,
        rate: "100",
        schedule: "month",
        token: "XLM",
      }),
    });

    const createRes = await createStreamV1(createReq);
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const streamId = created.data.id;

    expect(created.data.senderAddress).toBe(WALLET_SENDER);
    expect(created.data.ownership).toBe("individual");

    // Advance status to active to allow cancellation
    const stream = db.streams.get(streamId)!;
    stream.status = "active";
    db.streams.set(streamId, stream);

    // 2. Cancel with the same JWT
    const res = await cancelStream(
      cancelReq(streamId, { jwt: senderToken }),
      ctx(streamId),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancellation).toBeDefined();
    expect(body.cancellation.senderAddress).toBe(WALLET_SENDER);
    expect(body.data.status).toBe("cancelled");
    expect(body.data.senderAddress).toBe(WALLET_SENDER);
  });

  it("Row 2: Cancel with a different wallet -> 403 SENDER_AUTH_REQUIRED; stream unchanged", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const attackerToken = signToken(WALLET_ATTACKER);

    // Create stream owned by WALLET_SENDER
    const streamId = "stream-owned-by-sender";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    // Attacker tries to cancel with their own JWT
    const res = await cancelStream(
      cancelReq(streamId, { jwt: attackerToken }),
      ctx(streamId),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("SENDER_AUTH_REQUIRED");

    // Stream remains unchanged (still active, not cancelled)
    const streamAfter = db.streams.get(streamId);
    expect(streamAfter?.status).toBe("active");
    expect(streamAfter?.cancellation).toBeUndefined();
  });

  it("Row 3: Cancel an unclaimed stream with any actor -> 403 SENDER_UNKNOWN", async () => {
    const callerToken = signToken(WALLET_SENDER);

    // Seeded or unclaimed stream (e.g. stream-unclaimed)
    const unclaimedId = "stream-unclaimed";
    expect(db.streams.get(unclaimedId)?.ownership).toBe("unclaimed");

    // Try to cancel with valid JWT
    const resWithJwt = await cancelStream(
      cancelReq(unclaimedId, { jwt: callerToken }),
      ctx(unclaimedId),
    );
    expect(resWithJwt.status).toBe(403);
    const bodyJwt = await resWithJwt.json();
    expect(bodyJwt.error.code).toBe("SENDER_UNKNOWN");

    // Try to cancel with raw header
    const resWithHeader = await cancelStream(
      cancelReq(unclaimedId, { actorHeader: WALLET_SENDER }),
      ctx(unclaimedId),
    );
    expect(resWithHeader.status).toBe(403);
    const bodyHeader = await resWithHeader.json();
    expect(bodyHeader.error.code).toBe("SENDER_UNKNOWN");

    // Stream remains unchanged
    expect(db.streams.get(unclaimedId)?.status).toBe("active");
  });

  it("Row 4: Org-owned stream, canceller role -> 200", async () => {
    // stream-ada is owned by org-acme in orgDb
    const orgStreamId = "stream-ada";
    expect(orgDb.streamOwnership.get(orgStreamId)).toBe("org-acme");

    // Configure org-acme policy to allow single approval so stop executes immediately
    const org = orgDb.orgs.get("org-acme")!;
    org.policy = {
      ...DEFAULT_STREAM_POLICY,
      canStop: ["owner"],
      requireApprovals: 1,
    };
    orgDb.orgs.set("org-acme", org);

    // Owner cancels using Actor-Wallet-Address header (or JWT)
    const res = await cancelStream(
      cancelReq(orgStreamId, { actorHeader: ORG_OWNER }),
      ctx(orgStreamId),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("cancelled");
    expect(body.cancellation).toBeDefined();
    // Refund target is stream's recorded senderAddress, not caller
    expect(body.cancellation.senderAddress).toBe(
      "GSENDER00000000000000000000000000000000000000000000",
    );
  });

  it("Row 5: Header-only actor equal to the sender, header flag off -> 403 SENDER_AUTH_REQUIRED", async () => {
    // Individually owned stream has senderAddress WALLET_SENDER
    const streamId = "stream-header-only-test";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    // Caller sends Actor-Wallet-Address matching sender, but NO verified JWT
    const res = await cancelStream(
      cancelReq(streamId, { actorHeader: WALLET_SENDER }),
      ctx(streamId),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("SENDER_AUTH_REQUIRED");

    // Stream remains unchanged
    expect(db.streams.get(streamId)?.status).toBe("active");
  });

  it("Row 6: All creation paths set senderAddress when authenticated, and null/unclaimed when not", async () => {
    const senderToken = signToken(WALLET_SENDER);

    // Path 1: v1 POST /api/streams (authenticated)
    const v1AuthReq = new Request("http://localhost/api/streams", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify({
        recipient: WALLET_RECIPIENT,
        rate: "10",
        schedule: "month",
        token: "XLM",
      }),
    });
    const v1AuthRes = await createStreamV1(v1AuthReq);
    expect(v1AuthRes.status).toBe(201);
    const v1AuthBody = await v1AuthRes.json();
    expect(v1AuthBody.data.senderAddress).toBe(WALLET_SENDER);
    expect(v1AuthBody.data.ownership).toBe("individual");

    // Path 1: v1 POST /api/streams (unauthenticated)
    const v1UnauthReq = new Request("http://localhost/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: WALLET_RECIPIENT,
        rate: "10",
        schedule: "month",
        token: "XLM",
      }),
    });
    const v1UnauthRes = await createStreamV1(v1UnauthReq);
    expect(v1UnauthRes.status).toBe(201);
    const v1UnauthBody = await v1UnauthRes.json();
    expect(v1UnauthBody.data.senderAddress).toBeNull();
    expect(v1UnauthBody.data.ownership).toBe("unclaimed");

    // Path 2: v2 POST /api/v2/streams (authenticated)
    const v2Req = new Request("http://localhost/api/v2/streams", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify({
        recipient: WALLET_RECIPIENT,
        rate: "10 XLM/month",
        schedule: "month",
      }),
    });
    const v2Res = await createStreamV2(v2Req);
    expect(v2Res.status).toBe(201);
    const v2Body = await v2Res.json();
    expect(v2Body.senderAddress).toBe(WALLET_SENDER);
    expect(v2Body.ownership).toBe("individual");

    // Path 3: v1 batch POST /api/streams/batch (authenticated)
    const batchReq = new NextRequest("http://localhost/api/streams/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify([
        {
          recipient: WALLET_RECIPIENT,
          rate: "10",
          schedule: "month",
          token: "XLM",
        },
      ]),
    });
    const batchRes = await createBatchStream(batchReq);
    expect(batchRes.status).toBe(201);
    const batchBody = await batchRes.json();
    expect(batchBody.data[0].senderAddress).toBe(WALLET_SENDER);
    expect(batchBody.data[0].ownership).toBe("individual");

    // Path 4: v1 import POST /api/streams/import (authenticated)
    const importReq = new Request("http://localhost/api/streams/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify({
        rows: [
          {
            recipient: WALLET_RECIPIENT,
            rate: "10",
            schedule: "month",
            token: "XLM",
          },
        ],
      }),
    });
    const importRes = await createImportStream(importReq);
    expect(importRes.status).toBe(207);
    const importBody = await importRes.json();
    const importedStreamId = importBody.results[0].streamId;
    const importedStream = db.streams.get(importedStreamId);
    expect(importedStream?.senderAddress).toBe(WALLET_SENDER);
    expect(importedStream?.ownership).toBe("individual");

    // Path 5: v2 multi POST /api/v2/streams/multi (authenticated)
    const multiReq = new Request("http://localhost/api/v2/streams/multi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${senderToken}`,
      },
      body: JSON.stringify({
        name: "Q4 Distribution",
        token: "XLM",
        totalAmount: 1000,
        startTime: "2026-10-01T00:00:00Z",
        endTime: "2026-12-31T00:00:00Z",
        recipients: [
          { address: WALLET_RECIPIENT, percentage: 100, amount: 1000 },
        ],
      }),
    });
    const multiRes = await createMultiStream(multiReq);
    expect(multiRes.status).toBe(201);
    const multiBody = await multiRes.json();
    expect(multiBody.senderAddress).toBe(WALLET_SENDER);
    expect(multiBody.ownership).toBe("individual");
    const legId = multiBody.recipients[0].stream_id;
    const legStream = db.streams.get(legId);
    expect(legStream?.senderAddress).toBe(WALLET_SENDER);
    expect(legStream?.ownership).toBe("individual");
  });

  it("Row 7: Cancellation record never contains 'unknown'", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const streamId = "stream-no-unknown-check";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    const res = await cancelStream(
      cancelReq(streamId, { jwt: senderToken }),
      ctx(streamId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const cancellationJson = JSON.stringify(body.cancellation);
    expect(cancellationJson).not.toContain("unknown");
    expect(body.cancellation.senderAddress).toBe(WALLET_SENDER);
  });

  it("Row 8: Audit event actor equals verified sender", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const streamId = "stream-audit-test";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    const res = await cancelStream(
      cancelReq(streamId, { jwt: senderToken }),
      ctx(streamId),
    );
    expect(res.status).toBe(200);

    const auditEvents = auditLogStore.list({
      targetId: streamId,
      action: "stream.cancel",
    });
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].actor.id).toBe(WALLET_SENDER);
  });

  it("returns 404 for non-existent stream", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const res = await cancelStream(
      cancelReq("stream-non-existent", { jwt: senderToken }),
      ctx("stream-non-existent"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns 409 ALREADY_TERMINAL when stream is ended or cancelled", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const streamId = "stream-ended-test";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "ended",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    const res = await cancelStream(
      cancelReq(streamId, { jwt: senderToken }),
      ctx(streamId),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("ALREADY_TERMINAL");
  });

  it("supports Idempotency-Key header on cancellation", async () => {
    const senderToken = signToken(WALLET_SENDER);
    const streamId = "stream-idempotency-test";
    db.streams.set(streamId, {
      id: streamId,
      recipient: WALLET_RECIPIENT,
      rate: "100",
      schedule: "month",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      token: "XLM",
      senderAddress: WALLET_SENDER,
      ownership: "individual",
    });

    const idemKey = "test-idem-key-12345";
    const res1 = await cancelStream(
      cancelReq(streamId, { jwt: senderToken, idempotencyKey: idemKey }),
      ctx(streamId),
    );
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    const res2 = await cancelStream(
      cancelReq(streamId, { jwt: senderToken, idempotencyKey: idemKey }),
      ctx(streamId),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.cancellation.recipientTxHash).toBe(
      body1.cancellation.recipientTxHash,
    );
  });

  it("rejects org-owned stream cancel when actor lacks canceller role or multi-sig approval is required", async () => {
    const orgStreamId = "stream-ada";

    // Default org-acme policy requires 2 approvals -> 409 APPROVAL_REQUIRED
    const resApproval = await cancelStream(
      cancelReq(orgStreamId, { actorHeader: ORG_OWNER }),
      ctx(orgStreamId),
    );
    expect(resApproval.status).toBe(409);
    const bodyApproval = await resApproval.json();
    expect(bodyApproval.error.code).toBe("APPROVAL_REQUIRED");

    // Non-member actor -> 403
    const resDenied = await cancelStream(
      cancelReq(orgStreamId, { actorHeader: WALLET_ATTACKER }),
      ctx(orgStreamId),
    );
    expect(resDenied.status).toBe(403);

    // Missing actor identity -> 403 ACTOR_REQUIRED
    const resNoActor = await cancelStream(
      cancelReq(orgStreamId, {}),
      ctx(orgStreamId),
    );
    expect(resNoActor.status).toBe(403);
    const bodyNoActor = await resNoActor.json();
    expect(bodyNoActor.error.code).toBe("ACTOR_REQUIRED");

    // Org stream with no senderAddress -> 403 SENDER_UNKNOWN
    const stream = db.streams.get(orgStreamId)!;
    stream.senderAddress = null;
    db.streams.set(orgStreamId, stream);
    const resNoSender = await cancelStream(
      cancelReq(orgStreamId, { actorHeader: ORG_OWNER }),
      ctx(orgStreamId),
    );
    expect(resNoSender.status).toBe(403);
    const bodyNoSender = await resNoSender.json();
    expect(bodyNoSender.error.code).toBe("SENDER_UNKNOWN");
  });
});
