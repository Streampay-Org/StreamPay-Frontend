/** @jest-environment node */

import { GET, PUT } from "./route";
import { _resetOrgDbForTesting, orgDb } from "@/app/lib/org-db";
import {
  checkOrgPolicy,
  enforceStreamRbac,
  initiateApproval,
} from "@/app/lib/org-policy";
import { DEFAULT_STREAM_POLICY, type StreamPolicy } from "@/app/lib/org-types";
import { auditLogStore } from "@/app/lib/audit-log";

const OWNER_ADDR = "GOWNER7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";
const PAUSER_ADDR = "GPAUSER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7G";
const SETTLER_ADDR = "GSETTLER5IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const VIEWER_ADDR = "GVIEWER75IVFB7MG6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GS";
const OUTSIDER_ADDR = "GOUTSIDER6ZKKIFPWFNVJBXVPUMTYV5ANT2O2ZWL7GSDZWNRW";

function callGet(orgId: string) {
  const req = new Request(`http://localhost/api/orgs/${orgId}/policy`);
  return GET(req, { params: Promise.resolve({ orgId }) });
}

function callPut(
  orgId: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const req = new Request(`http://localhost/api/orgs/${orgId}/policy`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ orgId }) });
}

describe("GET / PUT /api/orgs/[orgId]/policy", () => {
  beforeEach(() => {
    _resetOrgDbForTesting();
    auditLogStore.reset([]);
  });

  describe("GET", () => {
    it("returns the current org policy with a strong ETag", async () => {
      const res = await callGet("org-acme");
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/);

      const json = await res.json();
      expect(json.data.orgId).toBe("org-acme");
      expect(json.data.policy).toEqual({
        ...DEFAULT_STREAM_POLICY,
        requireApprovals: 2,
      });
      expect(json.links.self).toBe("/api/orgs/org-acme/policy");
    });

    it("returns 404 for unknown org", async () => {
      const res = await callGet("org-unknown");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe("ORG_NOT_FOUND");
    });
  });

  describe("PUT — authorization", () => {
    const validPolicy: StreamPolicy = {
      ...DEFAULT_STREAM_POLICY,
      canStop: ["owner", "pauser"],
      requireApprovals: 1,
    };

    it("returns 404 for unknown org", async () => {
      const res = await callPut(
        "org-unknown",
        { policy: validPolicy },
        { "Actor-Wallet-Address": OWNER_ADDR },
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error.code).toBe("ORG_NOT_FOUND");
    });

    it("returns 403 ACTOR_REQUIRED when actor identity is missing", async () => {
      const res = await callPut("org-acme", { policy: validPolicy });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("ACTOR_REQUIRED");
    });

    it.each([
      ["pauser", PAUSER_ADDR],
      ["settler", SETTLER_ADDR],
      ["viewer", VIEWER_ADDR],
      ["outsider", OUTSIDER_ADDR],
    ])("rejects %s with 403 FORBIDDEN without mutating policy", async (_label, addr) => {
      const before = structuredClone(orgDb.orgs.get("org-acme")!.policy);

      const res = await callPut(
        "org-acme",
        { policy: validPolicy },
        { "Actor-Wallet-Address": addr },
      );

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("FORBIDDEN");
      expect(orgDb.orgs.get("org-acme")!.policy).toEqual(before);
      expect(auditLogStore.list({ orgId: "org-acme" })).toHaveLength(0);
    });
  });

  describe("PUT — validation", () => {
    it("returns 400 INVALID_REQUEST for malformed JSON", async () => {
      const res = await callPut("org-acme", "{not-json", {
        "Actor-Wallet-Address": OWNER_ADDR,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("INVALID_REQUEST");
    });

    it("rejects removing owner, invalid requireApprovals, and unknown roles without partial writes", async () => {
      const before = structuredClone(orgDb.orgs.get("org-acme")!.policy);

      const res = await callPut(
        "org-acme",
        {
          policy: {
            ...DEFAULT_STREAM_POLICY,
            canStop: ["pauser"],
            canPause: ["owner", "wizard"],
            requireApprovals: 3,
          },
        },
        { "Actor-Wallet-Address": OWNER_ADDR },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.details.fieldErrors.canStop).toMatch(/owner/i);
      expect(json.error.details.fieldErrors.canPause).toMatch(/wizard/);
      expect(json.error.details.fieldErrors.requireApprovals).toMatch(/1 or 2/);

      // No partial writes
      expect(orgDb.orgs.get("org-acme")!.policy).toEqual(before);
      expect(auditLogStore.list({ orgId: "org-acme" })).toHaveLength(0);
    });
  });

  describe("PUT — persistence, immediate enforcement, and audit", () => {
    it("updates policy, is immediately honoured by checkOrgPolicy and enforceStreamRbac, and writes an audit record", async () => {
      const getRes = await callGet("org-acme");
      const initialEtag = getRes.headers.get("ETag")!;

      const nextPolicy: StreamPolicy = {
        ...DEFAULT_STREAM_POLICY,
        canStop: ["owner", "pauser"],
        requireApprovals: 1,
      };

      const putRes = await callPut(
        "org-acme",
        { policy: nextPolicy },
        {
          "Actor-Wallet-Address": OWNER_ADDR,
          "If-Match": initialEtag,
          "x-request-id": "req_policy_update_1",
        },
      );

      expect(putRes.status).toBe(200);
      const newEtag = putRes.headers.get("ETag");
      expect(newEtag).toBeTruthy();
      expect(newEtag).not.toBe(initialEtag);

      const json = await putRes.json();
      expect(json.data.policy).toEqual(nextPolicy);

      // Immediately honoured by checkOrgPolicy
      const org = orgDb.orgs.get("org-acme")!;
      const policyCheck = checkOrgPolicy(org, PAUSER_ADDR, "stop");
      expect(policyCheck).toEqual({ allowed: true, requiresApproval: false });

      // Immediately honoured by enforceStreamRbac
      const rbacReq = new Request("http://localhost/api/streams/stream-ada/stop", {
        headers: { "Actor-Wallet-Address": PAUSER_ADDR },
      });
      expect(enforceStreamRbac(rbacReq, "stream-ada", "stop")).toBeNull();

      // Audit record written to org audit log with before/after, actor, requestId
      const entries = auditLogStore.list({ orgId: "org-acme" });
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.action).toBe("org.policy.update");
      expect(entry.actor.id).toBe(OWNER_ADDR);
      expect(entry.requestId).toBe("req_policy_update_1");
      expect(entry.beforeHash).toBeTruthy();
      expect(entry.afterHash).toBeTruthy();
      expect(entry.diffHash).toBeTruthy();
      expect(JSON.parse(String(entry.metadata?.beforePolicy))).toEqual({
        ...DEFAULT_STREAM_POLICY,
        requireApprovals: 2,
      });
      expect(JSON.parse(String(entry.metadata?.afterPolicy))).toEqual(nextPolicy);
    });

    it("rejects concurrent edit with stale If-Match (409 STATE_CONFLICT)", async () => {
      const getRes = await callGet("org-acme");
      const staleEtag = getRes.headers.get("ETag")!;

      // First edit succeeds
      const first = await callPut(
        "org-acme",
        {
          policy: {
            ...DEFAULT_STREAM_POLICY,
            requireApprovals: 1,
          },
        },
        {
          "Actor-Wallet-Address": OWNER_ADDR,
          "If-Match": staleEtag,
        },
      );
      expect(first.status).toBe(200);

      // Second edit with stale ETag fails with 409 STATE_CONFLICT
      const second = await callPut(
        "org-acme",
        {
          policy: {
            ...DEFAULT_STREAM_POLICY,
            canStop: ["owner", "settler"],
            requireApprovals: 2,
          },
        },
        {
          "Actor-Wallet-Address": OWNER_ADDR,
          "If-Match": staleEtag,
        },
      );
      expect(second.status).toBe(409);
      const json = await second.json();
      expect(json.error.code).toBe("STATE_CONFLICT");
    });

    it("preserves existing pending approvals when requireApprovals changes", async () => {
      const initiated = initiateApproval("stream-ada", "org-acme", "stop", OWNER_ADDR, 2);
      expect(initiated.ok).toBe(true);
      if (!initiated.ok) return;

      const res = await callPut(
        "org-acme",
        {
          policy: {
            ...DEFAULT_STREAM_POLICY,
            requireApprovals: 1,
          },
        },
        { "Actor-Wallet-Address": OWNER_ADDR },
      );
      expect(res.status).toBe(200);

      // Existing pending approval remains intact with its original requiredCount
      const stored = orgDb.approvals.get(initiated.approval.id);
      expect(stored?.status).toBe("pending");
      expect(stored?.requiredCount).toBe(2);

      // Subsequent policy checks immediately reflect requireApprovals: 1
      const check = checkOrgPolicy(orgDb.orgs.get("org-acme")!, OWNER_ADDR, "stop");
      expect(check).toEqual({ allowed: true, requiresApproval: false });
    });
  });
});
