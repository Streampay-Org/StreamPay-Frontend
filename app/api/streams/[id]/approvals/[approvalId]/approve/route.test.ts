/**
 * @jest-environment node
 *
 * approve/route.test.ts — Test suite for approval execution on threshold
 *
 * Scenarios tested according to issue test plan:
 * 1. Threshold of 2, two votes for pause -> Stream paused; approval executed
 * 2. Third vote after execution -> 409 APPROVAL_ALREADY_EXECUTED; no second state change
 * 3. Two concurrent final votes -> One execution, one audit record (Promise.all)
 * 4. Stream stopped before the final vote -> Approval failed, 409 ILLEGAL_TRANSITION, stream unchanged
 * 5. Expired approval -> 410 APPROVAL_EXPIRED
 * 6. Approved settle with the settlement client rejecting -> Approval stays approved (not executed); 502; retryable
 * 7. Direct pause route after the refactor -> Behaviour unchanged
 * 8. Response request_id -> Matches the correlation id
 */

import { POST as approvePOST } from "./route";
import { POST as pausePOST } from "@/app/api/streams/[id]/pause/route";
import { db, resetDb } from "@/app/lib/db";
import { orgDb, _resetOrgDbForTesting, OrgRecord } from "@/app/lib/org-db";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";
import { PendingApproval } from "@/app/lib/org-types";
import { withCorrelationContext } from "@/app/lib/logger";

const ORG_ID = "org-acme";
const STREAM_ID = "stream-ada"; // Initial status: active

// Members in org-acme (from seed data):
// Owner: GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW
// Pauser: GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G
// Settler: GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS
const OWNER = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const PAUSER = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";
const SETTLER = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";

function makeApproveReq(streamId: string, approvalId: string, actor: string, requestId?: string) {
  const headers: Record<string, string> = {
    "Actor-Wallet-Address": actor,
  };
  if (requestId) {
    headers["x-request-id"] = requestId;
  }
  return new Request(`http://localhost/api/streams/${streamId}/approvals/${approvalId}/approve`, {
    method: "POST",
    headers,
  });
}

function makeParams(streamId: string, approvalId: string) {
  return {
    params: Promise.resolve({ id: streamId, approvalId }),
  };
}

describe("POST /api/streams/:id/approvals/:approvalId/approve", () => {
  beforeEach(() => {
    resetDb();
    resetAuditLogStore();
    _resetOrgDbForTesting();
    delete (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__;

    // Ensure stream-ada is active and owned by org-acme
    orgDb.streamOwnership.set(STREAM_ID, ORG_ID);
    const org = orgDb.orgs.get(ORG_ID)!;
    // Set policy to require 2 approvals for actions
    org.policy.requireApprovals = 2;
  });

  afterEach(() => {
    delete (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__;
  });

  it("Scenario 1: Threshold of 2, two votes for pause -> Stream paused; approval executed", async () => {
    // Setup a pending approval for pause initiated by OWNER (1 vote)
    const approvalId = "appr-pause-1";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 2,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    // Vote 2: cast by PAUSER (threshold met!)
    const req = makeApproveReq(STREAM_ID, approvalId, PAUSER);
    const res = await approvePOST(req, makeParams(STREAM_ID, approvalId));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.meta.thresholdMet).toBe(true);
    expect(body.approval.status).toBe("executed");
    expect(body.approval.executedAt).toBeDefined();

    // Stream should now be paused
    const stream = db.streams.get(STREAM_ID);
    expect(stream?.status).toBe("paused");
    expect(stream?.pausedAt).toBeDefined();

    // Exactly one audit record for stream.pause with metadata.approvalId
    const auditEvents = auditLogStore.list().filter((e) => e.target.id === STREAM_ID && e.action === "stream.pause");
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].metadata?.approvalId).toBe(approvalId);
  });

  it("Scenario 2: Third vote after execution -> 409 APPROVAL_ALREADY_EXECUTED; no second state change", async () => {
    const approvalId = "appr-pause-2";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER, PAUSER],
      requiredCount: 2,
      status: "executed",
      executedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    // Add another member to org for 3rd vote
    const THIRD_MEMBER = "GTHIRD7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
    const org = orgDb.orgs.get(ORG_ID)!;
    org.members.push({
      walletAddress: THIRD_MEMBER,
      role: "owner",
      addedAt: new Date().toISOString(),
    });

    const req = makeApproveReq(STREAM_ID, approvalId, THIRD_MEMBER);
    const res = await approvePOST(req, makeParams(STREAM_ID, approvalId));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.code).toBe("APPROVAL_ALREADY_EXECUTED");
  });

  it("Scenario 3: Two concurrent final votes -> One execution, one audit record", async () => {
    // Org requires 3 approvals
    const org = orgDb.orgs.get(ORG_ID)!;
    org.policy.requireApprovals = 3;

    const VOTER2 = PAUSER;
    const VOTER3 = "GVOTER37MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
    org.members.push({
      walletAddress: VOTER3,
      role: "owner",
      addedAt: new Date().toISOString(),
    });

    const approvalId = "appr-concurrent";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 3,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    // First cast 2nd vote
    const res2 = await approvePOST(makeApproveReq(STREAM_ID, approvalId, VOTER2), makeParams(STREAM_ID, approvalId));
    expect(res2.status).toBe(200);

    // Now, two concurrent calls with VOTER3
    // Simulate concurrent attempts with Promise.all
    const [concurrent1, concurrent2] = await Promise.all([
      approvePOST(makeApproveReq(STREAM_ID, approvalId, VOTER3), makeParams(STREAM_ID, approvalId)),
      approvePOST(makeApproveReq(STREAM_ID, approvalId, VOTER3), makeParams(STREAM_ID, approvalId)),
    ]);

    const statuses = [concurrent1.status, concurrent2.status];
    expect(statuses).toContain(200);
    expect(statuses).toContain(409); // The duplicate/concurrent call fails with 409

    // Exactly one pause audit event
    const auditEvents = auditLogStore.list().filter((e) => e.target.id === STREAM_ID && e.action === "stream.pause");
    expect(auditEvents.length).toBe(1);
  });

  it("Scenario 4: Stream stopped before the final vote -> Approval failed, 409 ILLEGAL_TRANSITION, stream unchanged", async () => {
    const approvalId = "appr-drift";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 2,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    // Stop the stream beforehand (state drift)
    const stream = db.streams.get(STREAM_ID)!;
    db.streams.set(STREAM_ID, { ...stream, status: "ended" });

    // Final vote cast by PAUSER
    const req = makeApproveReq(STREAM_ID, approvalId, PAUSER);
    const res = await approvePOST(req, makeParams(STREAM_ID, approvalId));
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error.code).toBe("ILLEGAL_TRANSITION");

    // Approval marked failed with reason ILLEGAL_TRANSITION
    const updatedApproval = orgDb.approvals.get(approvalId)!;
    expect(updatedApproval.status).toBe("failed");
    expect(updatedApproval.failureReason).toBe("ILLEGAL_TRANSITION");

    // Stream remains ended
    expect(db.streams.get(STREAM_ID)?.status).toBe("ended");
  });

  it("Scenario 5: Expired approval -> 410 APPROVAL_EXPIRED", async () => {
    const approvalId = "appr-expired";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 2,
      status: "pending",
      createdAt: new Date(Date.now() - 100000).toISOString(),
      expiresAt: new Date(Date.now() - 50000).toISOString(), // expired
    };
    orgDb.approvals.set(approvalId, approval);

    const req = makeApproveReq(STREAM_ID, approvalId, PAUSER);
    const res = await approvePOST(req, makeParams(STREAM_ID, approvalId));
    expect(res.status).toBe(410);

    const body = await res.json();
    expect(body.error.code).toBe("APPROVAL_EXPIRED");
  });

  it("Scenario 6: Approved settle with settlement client rejecting -> Approval stays approved (not executed); 502; retryable", async () => {
    (globalThis as any).__STREAMPAY_STELLAR_SETTLEMENT_CLIENT__ = {
      settleStream: jest.fn().mockRejectedValue(new Error("RPC Timeout")),
    };

    const approvalId = "appr-settle";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "settle",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 2,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    const req = makeApproveReq(STREAM_ID, approvalId, SETTLER);
    const res = await approvePOST(req, makeParams(STREAM_ID, approvalId));
    expect(res.status).toBe(502);

    const body = await res.json();
    expect(body.error.code).toBe("SETTLEMENT_FAILED");

    // Approval status stays approved (not executed), retryable
    const updatedApproval = orgDb.approvals.get(approvalId)!;
    expect(updatedApproval.status).toBe("approved");
    expect(updatedApproval.executedAt).toBeUndefined();

    // Stream remains active
    expect(db.streams.get(STREAM_ID)?.status).toBe("active");
  });

  it("Scenario 7: Direct pause route after the refactor -> Behaviour unchanged", async () => {
    // Individually owned or org without required approvals
    const org = orgDb.orgs.get(ORG_ID)!;
    org.policy.requireApprovals = 1;

    const req = new Request(`http://localhost/api/streams/${STREAM_ID}/pause`, {
      method: "POST",
      headers: { "Actor-Wallet-Address": OWNER },
    });
    const res = await pausePOST(req, { params: Promise.resolve({ id: STREAM_ID }) });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.status).toBe("paused");
  });

  it("Scenario 8: Response request_id -> Matches the correlation id", async () => {
    const approvalId = "appr-correl";
    const approval: PendingApproval = {
      id: approvalId,
      streamId: STREAM_ID,
      orgId: ORG_ID,
      action: "pause",
      initiatedBy: OWNER,
      approvals: [OWNER],
      requiredCount: 2,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    orgDb.approvals.set(approvalId, approval);

    const testRequestId = "req-custom-correlation-123";

    await withCorrelationContext({ request_id: testRequestId, correlation_id: "corr-1" }, async () => {
      // Test error path correlation
      const errReq = makeApproveReq(STREAM_ID, "non-existent-approval", PAUSER);
      const errRes = await approvePOST(errReq, makeParams(STREAM_ID, "non-existent-approval"));
      const errBody = await errRes.json();
      expect(errBody.error.request_id).toBe(testRequestId);
    });
  });
});
