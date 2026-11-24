/**
 * @jest-environment node
 */

import { GET } from "./route";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import type { PendingApproval } from "@/app/lib/org-types";

const OWNER_WALLET = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const SETTLER_WALLET = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const OUTSIDER_WALLET = "GOUTSIDER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWN";

function seedApproval(overrides: Partial<PendingApproval> & { id: string }): PendingApproval {
  const approval: PendingApproval = {
    streamId: "stream-ada",
    orgId: "org-acme",
    action: "settle",
    initiatedBy: OWNER_WALLET,
    approvals: [OWNER_WALLET],
    requiredCount: 2,
    status: "pending",
    createdAt: "2026-04-10T10:00:00.000Z",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
  orgDb.approvals.set(approval.id, approval);
  return approval;
}

describe("GET /api/approvals", () => {
  beforeEach(() => {
    _resetOrgDbForTesting();
  });

  it("returns empty list and zero counts when there are no approvals", async () => {
    const req = new Request("http://localhost/api/approvals");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta).toEqual({
      total: 0,
      counts: { pending: 0, approved: 0, rejected: 0, expired: 0 },
    });
    expect(body.links.self).toBe("/api/approvals");
  });

  it("aggregates approvals across org-owned streams sorted newest first", async () => {
    orgDb.streamOwnership.set("stream-beta-1", "org-beta");

    seedApproval({
      id: "appr-old",
      streamId: "stream-ada",
      orgId: "org-acme",
      status: "pending",
      createdAt: "2026-04-09T08:00:00.000Z",
    });
    seedApproval({
      id: "appr-new",
      streamId: "stream-beta-1",
      orgId: "org-beta",
      status: "approved",
      approvals: [OWNER_WALLET, SETTLER_WALLET],
      createdAt: "2026-04-10T12:00:00.000Z",
    });
    seedApproval({
      id: "appr-rej",
      streamId: "stream-ada",
      orgId: "org-acme",
      status: "rejected",
      createdAt: "2026-04-10T09:00:00.000Z",
    });

    const req = new Request("http://localhost/api/approvals");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((a: PendingApproval) => a.id)).toEqual([
      "appr-new",
      "appr-rej",
      "appr-old",
    ]);
    expect(body.meta.total).toBe(3);
    expect(body.meta.counts).toEqual({
      pending: 1,
      approved: 1,
      rejected: 1,
      expired: 0,
    });
  });

  it("filters approvals by Actor-Wallet-Address org membership", async () => {
    orgDb.streamOwnership.set("stream-beta-1", "org-beta");

    seedApproval({ id: "appr-acme", streamId: "stream-ada", orgId: "org-acme" });
    seedApproval({ id: "appr-beta", streamId: "stream-beta-1", orgId: "org-beta" });

    const req = new Request("http://localhost/api/approvals", {
      headers: { "Actor-Wallet-Address": SETTLER_WALLET },
    });
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((a: PendingApproval) => a.id)).toEqual(["appr-acme"]);

    const outsiderReq = new Request("http://localhost/api/approvals", {
      headers: { "Actor-Wallet-Address": OUTSIDER_WALLET },
    });
    const outsiderRes = await GET(outsiderReq);
    const outsiderBody = await outsiderRes.json();
    expect(outsiderBody.data).toEqual([]);
  });

  it("lazily marks expired pending approvals and supports status query filtering", async () => {
    seedApproval({
      id: "appr-expired",
      status: "pending",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    seedApproval({
      id: "appr-active",
      status: "pending",
    });

    const req = new Request("http://localhost/api/approvals?status=pending");
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((a: PendingApproval) => a.id)).toEqual(["appr-active"]);
    expect(body.meta.counts).toEqual({
      pending: 1,
      approved: 0,
      rejected: 0,
      expired: 1,
    });
    expect(orgDb.approvals.get("appr-expired")?.status).toBe("expired");
  });

  it("returns 400 for an invalid status query parameter", async () => {
    const req = new Request("http://localhost/api/approvals?status=bogus");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});
