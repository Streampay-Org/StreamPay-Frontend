/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET, POST, PUT, PATCH, DELETE, OPTIONS } from "./route";
import { JWT_SECRET } from "@/app/lib/auth";
import { auditLogStore, resetAuditLogStore } from "@/app/lib/audit-log";

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

function seedArchivedEntries() {
  auditLogStore.append({
    action: "stream.settle",
    actor: { id: "admin-1", role: "admin" },
    after: { status: "ended" },
    before: { status: "active" },
    requestId: "req-archive-001",
    target: { account: "acct_old_sensitive", id: "stream-old", type: "stream" },
    timestamp: "2024-01-01T12:00:00.000Z",
  });
  auditLogStore.append({
    action: "stream.withdraw",
    actor: { id: "admin-2", role: "admin" },
    after: { status: "withdrawn" },
    before: { status: "ended" },
    requestId: "req-archive-002",
    target: { account: "acct_old_second", id: "stream-older", type: "stream" },
    timestamp: "2024-01-02T12:00:00.000Z",
  });
  auditLogStore.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
  auditLogStore.deepArchive("2025-01-01T00:00:00.000Z");
}

describe("GET /api/audit/archive", () => {
  beforeEach(() => {
    resetAuditLogStore();
  });

  it("returns 401 when no token is provided", async () => {
    const response = await GET(makeRequest("/api/audit/archive"));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for roles without export access", async () => {
    for (const role of ["user", "support", "finance"]) {
      const response = await GET(makeRequest("/api/audit/archive", role));
      const body = await response.json();
      expect(response.status).toBe(403);
      expect(body.error.code).toBe("FORBIDDEN");
    }
  });

  it("streams archived NDJSON rows with integrity headers for an admin", async () => {
    seedArchivedEntries();

    const response = await GET(makeRequest("/api/audit/archive", "admin", "admin-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("x-audit-chain-intact")).toBe("true");
    expect(response.headers.get("x-audit-retention-days")).toBe("30");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);

    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((row) => row.requestId)).toEqual([
      "req-archive-002",
      "req-archive-001",
    ]);
    for (const row of rows) {
      expect(row.redactionPolicy).toBe("mask-target-account");
      expect(row.redactedTargetAccount).not.toContain("acct_");
      expect(row.entryHash).toBeTruthy();
    }
  });

  it("allows compliance and security roles to download the archive", async () => {
    seedArchivedEntries();

    for (const role of ["compliance", "security"]) {
      const response = await GET(makeRequest("/api/audit/archive", role, `${role}-1`));
      expect(response.status).toBe(200);
    }
  });

  it("returns an empty NDJSON body when the archive is empty", async () => {
    const response = await GET(makeRequest("/api/audit/archive", "admin", "admin-1"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.trim()).toBe("");
  });

  it("honours and clamps the limit parameter", async () => {
    seedArchivedEntries();

    const limited = await GET(makeRequest("/api/audit/archive?limit=1", "admin", "admin-1"));
    const limitedText = await limited.text();
    expect(limitedText.trim().split("\n")).toHaveLength(1);

    const clamped = await GET(makeRequest("/api/audit/archive?limit=0", "admin", "admin-1"));
    const clampedText = await clamped.text();
    expect(clampedText.trim().split("\n")).toHaveLength(1);
  });

  it("is deterministic for identical archive state", async () => {
    seedArchivedEntries();

    const first = await GET(makeRequest("/api/audit/archive", "admin", "admin-1"));
    const second = await GET(makeRequest("/api/audit/archive", "admin", "admin-1"));
    expect(await first.text()).toBe(await second.text());
  });

  it("rejects mutations with 405", async () => {
    for (const method of [POST, PUT, PATCH, DELETE]) {
      const response = await method();
      const body = await response.json();
      expect(response.status).toBe(405);
      expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
    }
  });

  it("advertises GET/OPTIONS via OPTIONS", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("Allow")).toBe("GET, OPTIONS");
  });
});
