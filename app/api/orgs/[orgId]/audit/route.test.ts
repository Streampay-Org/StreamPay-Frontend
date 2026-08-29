/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET } from "./route";
import { JWT_SECRET } from "@/app/lib/auth";
import { auditLogStore } from "@/app/lib/audit-log";
import { _resetOrgDbForTesting } from "@/app/lib/org-db";

function signAccessToken(role: string, actorId: string) {
  return jwt.sign(
    { sub: `${actorId}-wallet`, role, actorId, iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
    { expiresIn: "15m" },
  );
}

function makeRequest(path: string, role?: string, actorId?: string) {
  return new Request(`http://localhost${path}`, {
    headers: role
      ? { authorization: `Bearer ${signAccessToken(role, actorId ?? role)}` }
      : {},
  });
}

function callGet(request: Request, orgId: string) {
  return GET(request, { params: Promise.resolve({ orgId }) });
}

describe("GET /api/orgs/[orgId]/audit", () => {
  beforeEach(() => {
    auditLogStore.reset([]);
    _resetOrgDbForTesting();
    auditLogStore.append({
      action: "stream.settle",
      actor: { id: "admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-org-audit-001",
      target: { account: "acct_org_admin", id: "stream-ada", type: "stream" },
      timestamp: "2026-04-28T12:00:00.000Z",
      metadata: { orgId: "org-acme" },
    });
  });

  it("returns 401 when no token is provided", async () => {
    const response = await callGet(makeRequest("/api/orgs/org-acme/audit"), "org-acme");
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for roles without audit read access", async () => {
    for (const role of ["user", "system"]) {
      const response = await callGet(makeRequest("/api/orgs/org-acme/audit", role), "org-acme");
      const body = await response.json();
      expect(response.status).toBe(403);
      expect(body.error.code).toBe("FORBIDDEN");
    }
  });

  it("returns org-scoped audit entries for an audit-read role", async () => {
    const response = await callGet(makeRequest("/api/orgs/org-acme/audit", "admin", "admin-1"), "org-acme");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.orgId).toBe("org-acme");
    expect(body.count).toBe(1);
    expect(body.chainIntact).toBe(true);
    expect(body.entries[0].requestId).toBe("req-org-audit-001");
  });

  it("allows all audit-read roles", async () => {
    for (const role of ["support", "admin", "finance", "security", "compliance"]) {
      const response = await callGet(makeRequest(`/api/orgs/org-acme/audit`, role, `${role}-1`), "org-acme");
      expect(response.status).toBe(200);
    }
  });

  it("returns 404 for a non-existent org to authorized callers", async () => {
    const response = await callGet(makeRequest("/api/orgs/org-does-not-exist/audit", "admin", "admin-1"), "org-does-not-exist");
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("ORG_NOT_FOUND");
  });

  it("honours limit and action filters", async () => {
    auditLogStore.append({
      action: "stream.withdraw",
      actor: { id: "admin-1", role: "admin" },
      after: { status: "withdrawn" },
      before: { status: "ended" },
      requestId: "req-org-audit-002",
      target: { account: "acct_org_admin", id: "stream-ada", type: "stream" },
      timestamp: "2026-04-28T13:00:00.000Z",
      metadata: { orgId: "org-acme" },
    });

    const filtered = await callGet(makeRequest("/api/orgs/org-acme/audit?action=stream.withdraw", "admin", "admin-1"), "org-acme");
    const filteredBody = await filtered.json();
    expect(filteredBody.count).toBe(1);
    expect(filteredBody.entries[0].action).toBe("stream.withdraw");

    const limited = await callGet(makeRequest("/api/orgs/org-acme/audit?limit=1", "admin", "admin-1"), "org-acme");
    const limitedBody = await limited.json();
    expect(limitedBody.entries).toHaveLength(1);
  });
});
