/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET, POST, PUT, PATCH, DELETE, OPTIONS } from "./route";
import { getJwtSecret } from "@/app/lib/auth";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";

function signAccessToken(
  role: string,
  actorId: string,
  secret: string = getJwtSecret(),
) {
  return jwt.sign(
    { sub: `${actorId}-wallet`, role, actorId, iss: "streampay", aud: "streampay-api" },
    secret,
    { expiresIn: "15m" },
  );
}

function makeRequest(
  path: string,
  role: string,
  actorId: string,
  extraHeaders?: Record<string, string>,
) {
  return new Request(`http://localhost${path}`, {
    headers: {
      authorization: `Bearer ${signAccessToken(role, actorId)}`,
      ...extraHeaders,
    },
  });
}

describe("GET /api/audit/export", () => {
  beforeEach(() => {
    resetAuditLogStore();
    auditLogStore.append({
      action: "stream.settle",
      actor: { id: "admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-export-001",
      target: { account: "acct_demo_admin", id: "stream-abc", type: "stream" },
      timestamp: "2026-04-28T12:00:00.000Z",
    });
    auditLogStore.append({
      action: "stream.create",
      actor: { id: "admin-2", role: "admin" },
      after: { status: "active" },
      before: null,
      requestId: "req-export-002",
      target: { account: "acct_second", id: "stream-def", type: "stream" },
      timestamp: "2026-04-28T13:00:00.000Z",
    });
    auditLogStore.append({
      action: "stream.pause",
      actor: { id: "compliance-1", role: "compliance" },
      after: { status: "paused" },
      before: { status: "active" },
      requestId: "req-export-003",
      target: { account: "acct_compliance", id: "stream-ghi", type: "stream" },
      timestamp: "2026-04-28T14:00:00.000Z",
      metadata: { orgId: "org-grantfox" },
    });
  });

  it("returns 401 when no token is provided", async () => {
    const request = new Request("http://localhost/api/audit/export");
    const response = await GET(request);
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.request_id).not.toBe("mock-request-id");
    expect(response.headers.get("x-request-id")).toBe(body.error.request_id);
  });

  it("returns 403 when a non-export role (support) calls the endpoint", async () => {
    const response = await GET(makeRequest("/api/audit/export", "support", "support-9"));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.request_id).toBeTruthy();
    expect(body.error.request_id).not.toBe("mock-request-id");
  });

  it("returns 403 for user role", async () => {
    const response = await GET(makeRequest("/api/audit/export", "user", "user-1"));
    expect(response.status).toBe(403);
  });

  it("returns 403 for finance role", async () => {
    const response = await GET(makeRequest("/api/audit/export", "finance", "finance-1"));
    expect(response.status).toBe(403);
  });

  it("streams NDJSON rows for an admin and includes chain-integrity header", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?actorId=admin-1&requestId=req-export-001", "admin", "admin-1"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("x-audit-chain-intact")).toBe("true");
    expect(response.headers.get("x-audit-retention-days")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);

    const rows = lines.map((l) => JSON.parse(l));
    expect(rows[0].action).toBe("stream.settle");
    expect(rows[0].requestId).toBe("req-export-001");
    expect(rows[0].redactedTargetAccount).toBeDefined();
    expect(rows[0].redactedTargetAccount).not.toBe("acct_demo_admin");
    expect(rows[0].redactionPolicy).toBe("mask-target-account");
  });

  it("includes x-request-id correlation header in success response", async () => {
    const response = await GET(
      makeRequest("/api/audit/export", "admin", "admin-1"),
    );
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("propagates x-request-id from request header", async () => {
    const response = await GET(
      makeRequest("/api/audit/export", "admin", "admin-1", { "x-request-id": "corr-abc-123" }),
    );
    expect(response.headers.get("x-request-id")).toBe("corr-abc-123");
  });

  it("propagates x-correlation-id as fallback", async () => {
    const response = await GET(
      makeRequest("/api/audit/export", "admin", "admin-1", { "x-correlation-id": "corr-fallback" }),
    );
    expect(response.headers.get("x-request-id")).toBe("corr-fallback");
  });

  it("allows compliance role to export and masks target accounts", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?actorId=compliance-1", "compliance", "compliance-1"),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows[0].actorRole).toBe("compliance");
    expect(rows[0].redactedTargetAccount).toBe("acct***ance");
    expect(rows[0].redactedTargetAccount).not.toBe("acct_compliance");
    expect(rows[0].redactionPolicy).toBe("mask-target-account");
  });

  it("allows security role to export", async () => {
    const response = await GET(
      makeRequest("/api/audit/export", "security", "security-1"),
    );
    expect(response.status).toBe(200);
  });

  it("honours the limit query parameter", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=1", "admin", "admin-1"),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("accepts the maximum limit of 250", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=250", "admin", "admin-1"),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(250);
  });

  it("rejects limit=0 with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=0", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_LIMIT");
  });

  it("rejects limit=251 with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=251", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_LIMIT");
  });

  it("rejects an over-limit value instead of clamping", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=9999", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
  });

  it("rejects a non-numeric limit with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=abc", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
  });

  it("rejects an empty limit with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
  });

  it("rejects a fractional limit with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=1.5", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
  });

  it("filters by action", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?action=stream.settle", "admin", "admin-1"),
    );
    const text = await response.text();
    const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.every((r: { action: string }) => r.action === "stream.settle")).toBe(true);
  });

  it("filters by role", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?role=compliance", "admin", "admin-1"),
    );
    const text = await response.text();
    const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r: { actorRole: string }) => r.actorRole === "compliance")).toBe(true);
  });

  it("rejects an invalid role filter with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?role=superadmin", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_ROLE_FILTER");
  });

  it("filters by targetId", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?targetId=stream-def", "admin", "admin-1"),
    );
    const text = await response.text();
    const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe("stream-def");
  });

  it("filters by free-text search (q)", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?q=compliance-1", "admin", "admin-1"),
    );
    const text = await response.text();
    const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r: { actorId: string }) => r.actorId === "compliance-1")).toBe(true);
  });

  it("returns all rows when no filters match", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?actorId=nonexistent", "admin", "admin-1"),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim()).toBe("");
  });

  it("returns empty NDJSON for no matching rows", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?actorId=no-such-actor", "admin", "admin-1"),
    );
    const text = await response.text();
    expect(text.trim()).toBe("");
  });

  it("rejects a negative limit with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=-5", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
  });

  it("streams NDJSON with multiple rows", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?limit=10", "admin", "admin-1"),
    );
    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.every((r: { id: string }) => typeof r.id === "string")).toBe(true);
    expect(rows.every((r: { entryHash: string }) => typeof r.entryHash === "string")).toBe(true);
  });

  it("redacts target accounts consistently", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?actorId=admin-1", "admin", "admin-1"),
    );
    const text = await response.text();
    const row = JSON.parse(text.trim());
    expect(row.redactedTargetAccount).toBe("acct***dmin");
    expect(row.redactionPolicy).toBe("mask-target-account");
  });

  it("filters by startDate query parameter", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?startDate=2026-04-28T13:00:00.000Z", "admin", "admin-1"),
    );
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.every((r: { timestamp: string }) => r.timestamp >= "2026-04-28T13:00:00.000Z")).toBe(true);
  });

  it("filters by endDate query parameter", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?endDate=2026-04-28T12:30:00.000Z", "admin", "admin-1"),
    );
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.every((r: { timestamp: string }) => r.timestamp <= "2026-04-28T12:30:00.000Z")).toBe(true);
  });

  it("filters by startDate and endDate combined", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?startDate=2026-04-28T12:30:00.000Z&endDate=2026-04-28T13:30:00.000Z", "admin", "admin-1"),
    );
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row.action).toBe("stream.create");
  });

  it("rejects an invalid startDate with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?startDate=not-a-date", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_DATE_FILTER");
  });

  it("rejects an invalid endDate with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?endDate=not-a-date", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_DATE_FILTER");
  });

  it("rejects a reversed date range with 422", async () => {
    const response = await GET(
      makeRequest(
        "/api/audit/export?startDate=2026-04-29T00:00:00.000Z&endDate=2026-04-28T00:00:00.000Z",
        "admin",
        "admin-1",
      ),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_DATE_RANGE");
  });

  it("ignores whitespace-only date parameter", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?startDate=%20%20", "admin", "admin-1"),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("streams CSV with formula-safe metadata and redacted accounts", async () => {
    auditLogStore.append({
      action: "stream.settle",
      actor: { id: "admin-formula", role: "admin" },
      after: { status: "ended" },
      before: null,
      requestId: "req-formula-001",
      target: { account: "acct_formula", id: "stream-formula", type: "stream" },
      timestamp: "2026-04-28T15:00:00.000Z",
      metadata: {
        note: "=SUM(A1:A2)",
        plus: "+cmd",
        minus: "-1+1",
        at: "@user",
      },
    });

    const response = await GET(
      makeRequest(
        "/api/audit/export?requestId=req-formula-001&format=csv",
        "admin",
        "admin-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toContain("redactionPolicy");
    expect(lines[0]).toContain("metadata");

    const row = lines.find((line) => line.includes("req-formula-001"));
    expect(row).toBeDefined();
    expect(row).toContain("'=SUM(A1:A2)");
    expect(row).toContain("'+cmd");
    expect(row).toContain("'-1+1");
    expect(row).toContain("'@user");
    expect(row).not.toContain("acct_formula");
    expect(row).toContain("acct***mula");
  });

  it("rejects an unsupported export format with 422", async () => {
    const response = await GET(
      makeRequest("/api/audit/export?format=xml", "admin", "admin-1"),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_EXPORT_FORMAT");
  });
});

describe("JWT secret resolution", () => {
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it("honours JWT_SECRET changes made after module import", async () => {
    const rotatedSecret = "rotated-secret-at-least-32-characters-long";
    process.env.JWT_SECRET = rotatedSecret;

    const response = await GET(
      makeRequest("/api/audit/export", "admin", "admin-1"),
    );
    expect(response.status).toBe(200);

    const staleSecret = originalJwtSecret ?? "streampay-dev-secret-do-not-use-in-prod";
    const staleToken = jwt.sign(
      {
        sub: "admin-1-wallet",
        role: "admin",
        actorId: "admin-1",
        iss: "streampay",
        aud: "streampay-api",
      },
      staleSecret,
      { expiresIn: "15m" },
    );
    const staleResponse = await GET(
      new Request("http://localhost/api/audit/export", {
        headers: { authorization: `Bearer ${staleToken}` },
      }),
    );
    expect(staleResponse.status).toBe(401);
  });
});

describe("HTTP method handlers", () => {
  it("returns 405 for POST requests", async () => {
    const response = await POST();
    const body = await response.json();
    expect(response.status).toBe(405);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns 405 for PUT requests", async () => {
    const response = await PUT();
    const body = await response.json();
    expect(response.status).toBe(405);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("returns 405 for PATCH requests", async () => {
    const response = await PATCH();
    const body = await response.json();
    expect(response.status).toBe(405);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("returns 405 for DELETE requests", async () => {
    const response = await DELETE();
    const body = await response.json();
    expect(response.status).toBe(405);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
  });

  it("returns 204 for OPTIONS with allowed methods header", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
});
