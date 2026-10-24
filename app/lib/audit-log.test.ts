/** @jest-environment node */

// Mock dependencies that have pre-existing syntax issues on this branch
jest.mock("@/app/lib/auth", () => ({
  tryAuthenticateRequest: jest.fn().mockReturnValue(null),
}));
jest.mock("@/lib/fingerprint", () => ({
  attachRequestFingerprintMetadata: jest.fn((_req: unknown, meta: unknown) => meta),
  REQUEST_FINGERPRINT_HEADER: "x-request-fingerprint",
}));
jest.mock("@/lib/fingerprint-audit", () => ({}));

import { AppendOnlyAuditLogStore } from "./audit-log";

describe("AppendOnlyAuditLogStore", () => {
  it("uses a 30-day retention window for new entries", () => {
    const store = new AppendOnlyAuditLogStore();

    const entry = store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-retention",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-04-28T10:00:00.000Z",
    });

    const expectedRetention = new Date("2026-05-28T10:00:00.000Z").toISOString();
    expect(entry.retentionUntil).toBe(expectedRetention);
  });

  it("creates a tamper-evident hash chain and rejects mutation attempts", () => {
    const store = new AppendOnlyAuditLogStore();

    const first = store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-1",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-04-28T10:00:00.000Z",
    });

    const second = store.append({
      action: "stream.withdraw",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "withdrawn" },
      before: { status: "ended" },
      requestId: "req-2",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-04-28T10:05:00.000Z",
    });

    expect(second.prevHash).toBe(first.entryHash);
    expect(store.assertIntegrity()).toBe(true);
    expect(() => store.updateEntry(first.id, { action: "stream.stop.override" })).toThrow("AUDIT_LOG_APPEND_ONLY");
    expect(() => store.deleteEntry(second.id)).toThrow("AUDIT_LOG_APPEND_ONLY");
  });

  it("archives expired entries and restores them without breaking the hash chain", () => {
    const store = new AppendOnlyAuditLogStore();

    const first = store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-archive-1",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2024-01-01T10:00:00.000Z",
    });

    const second = store.append({
      action: "stream.withdraw",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "withdrawn" },
      before: { status: "ended" },
      requestId: "req-archive-2",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2024-01-02T10:00:00.000Z",
    });

    const archived = store.archiveExpiredEntries("2024-02-05T00:00:00.000Z");

    expect(archived).toHaveLength(2);
    expect(store.count()).toBe(0);
    expect(store.assertIntegrity()).toBe(true);

    const restored = store.restoreArchivedEntries();

    expect(restored).toHaveLength(2);
    expect(restored[0].entryHash).toBe(first.entryHash);
    expect(restored[1].prevHash).toBe(first.entryHash);
    expect(restored[1].entryHash).toBe(second.entryHash);
    expect(store.count()).toBe(2);
    expect(store.assertIntegrity()).toBe(true);
  });

  it("redacts target account labels in exports", () => {
    const store = new AppendOnlyAuditLogStore();

    store.append({
      action: "stream.stop.override",
      actor: { id: "support-1", role: "support" },
      after: { status: "ended" },
      before: { status: "draft" },
      requestId: "req-export",
      target: { account: "acct_sensitive_target", id: "stream-2", type: "stream" },
      timestamp: "2026-04-28T11:00:00.000Z",
    });

    const [row] = store.exportRows({ requestId: "req-export" });

    expect(row.redactedTargetAccount).toBe("acct***rget");
    expect(row.redactionPolicy).toBe("mask-target-account");
  });

  describe("list filtering", () => {
    let store: AppendOnlyAuditLogStore;

    beforeEach(() => {
      store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "admin-1", role: "admin" },
        after: { status: "active" },
        requestId: "req-filter-1",
        target: { account: "acct_org1", id: "stream-1", type: "stream" },
        timestamp: "2026-04-28T10:00:00.000Z",
        metadata: { orgId: "org-alpha" },
      });
      store.append({
        action: "stream.settle",
        actor: { id: "admin-2", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-filter-2",
        target: { account: "acct_org2", id: "stream-2", type: "stream" },
        timestamp: "2026-05-01T12:00:00.000Z",
        metadata: { orgId: "org-beta" },
      });
      store.append({
        action: "stream.pause",
        actor: { id: "compliance-1", role: "compliance" },
        after: { status: "paused" },
        before: { status: "active" },
        requestId: "req-filter-3",
        target: { account: "acct_org1_admin", id: "stream-3", type: "stream" },
        timestamp: "2026-05-15T08:00:00.000Z",
        metadata: { orgId: "org-alpha", region: "us" },
      });
    });

    it("filters list by orgId via metadata", () => {
      const results = store.list({ orgId: "org-alpha" });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.metadata?.orgId === "org-alpha")).toBe(true);
    });

    it("filters list by orgId – no match", () => {
      const results = store.list({ orgId: "org-nonexistent" });
      expect(results).toHaveLength(0);
    });

    it("filters list by startDate (inclusive lower bound)", () => {
      const results = store.list({ startDate: "2026-05-01T00:00:00.000Z" });
      expect(results).toHaveLength(2);
    });

    it("filters list by endDate (inclusive upper bound)", () => {
      const results = store.list({ endDate: "2026-04-30T23:59:59.999Z" });
      expect(results).toHaveLength(1);
    });

    it("filters list by both startDate and endDate", () => {
      const results = store.list({
        startDate: "2026-04-28T00:00:00.000Z",
        endDate: "2026-04-30T23:59:59.999Z",
      });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("stream.create");
    });

    it("filters list by orgId combined with action", () => {
      const results = store.list({ orgId: "org-alpha", action: "stream.pause" });
      expect(results).toHaveLength(1);
      expect(results[0].action).toBe("stream.pause");
    });

    it("exportRows respects orgId filter", () => {
      const rows = store.exportRows({ orgId: "org-beta" });
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe("stream.settle");
    });

    it("exportRows respects startDate filter", () => {
      const rows = store.exportRows({ startDate: "2026-05-01T00:00:00.000Z" });
      expect(rows).toHaveLength(2);
    });

    it("exportRows respects endDate filter", () => {
      const rows = store.exportRows({ endDate: "2026-04-30T23:59:59.999Z" });
      expect(rows).toHaveLength(1);
    });

    it("orgId filter handles entries without metadata", () => {
      store.append({
        action: "stream.withdraw",
        actor: { id: "admin-1", role: "admin" },
        after: { status: "withdrawn" },
        before: { status: "ended" },
        requestId: "req-filter-no-meta",
        target: { account: "acct_nometa", id: "stream-4", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });
      const results = store.list({ orgId: "org-alpha" });
      expect(results).toHaveLength(2);
    });
  });

  describe("deepArchive", () => {
    it("archives entries older than the cutoff timestamp", () => {
      const store = new AppendOnlyAuditLogStore();

      const oldEntry = store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-deep-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-01-01T10:00:00.000Z",
      });

      const recentEntry = store.append({
        action: "stream.withdraw",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "withdrawn" },
        before: { status: "ended" },
        requestId: "req-deep-2",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });

      const result = store.deepArchive("2025-06-01T00:00:00.000Z");

      expect(result.archivedCount).toBe(1);
      expect(result.archivedEntryIds).toEqual([oldEntry.id]);
      expect(result.checkpointId).not.toBeNull();
      expect(store.count()).toBe(1);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].id).toBe(recentEntry.id);
    });

    it("preserves chain integrity after deep archive", () => {
      const store = new AppendOnlyAuditLogStore();

      store.append({
        action: "stream.create",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "draft" },
        requestId: "req-chain-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-01-01T10:00:00.000Z",
      });

      store.append({
        action: "stream.start",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "active" },
        before: { status: "draft" },
        requestId: "req-chain-2",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-06-01T10:00:00.000Z",
      });

      const recentEntry = store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-chain-3",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });

      const result = store.deepArchive("2026-01-01T00:00:00.000Z");

      expect(result.chainIntactBefore).toBe(true);
      expect(result.chainIntactAfter).toBe(true);
      expect(store.assertIntegrity()).toBe(true);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0].id).toBe(recentEntry.id);
    });

    it("returns archived entries via getDeepArchivedEntries", () => {
      const store = new AppendOnlyAuditLogStore();

      const oldEntry = store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-get-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-01-01T10:00:00.000Z",
      });

      store.deepArchive("2025-06-01T00:00:00.000Z");

      const archived = store.getDeepArchivedEntries();
      expect(archived).toHaveLength(1);
      expect(archived[0].entry.id).toBe(oldEntry.id);
      expect(archived[0].entry.action).toBe("stream.settle");
      expect(archived[0].archivedAt).toBeDefined();
    });

    it("returns empty result when no entries match the cutoff", () => {
      const store = new AppendOnlyAuditLogStore();

      store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-empty-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });

      const result = store.deepArchive("2025-01-01T00:00:00.000Z");

      expect(result.archivedCount).toBe(0);
      expect(result.archivedEntryIds).toEqual([]);
      expect(result.chainIntactAfter).toBe(true);
      expect(store.getDeepArchivedEntries()).toEqual([]);
    });

    it("archives entries from both active and soft-archived stores", () => {
      const store = new AppendOnlyAuditLogStore();

      const veryOldEntry = store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-both-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2024-01-01T10:00:00.000Z",
      });

      const oldEntry = store.append({
        action: "stream.withdraw",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "withdrawn" },
        before: { status: "ended" },
        requestId: "req-both-2",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2024-06-01T10:00:00.000Z",
      });

      const recentEntry = store.append({
        action: "stream.stop.override",
        actor: { id: "support-1", role: "support" },
        after: { status: "ended" },
        before: { status: "draft" },
        requestId: "req-both-3",
        target: { account: "acct_demo_001", id: "stream-2", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });

      store.archiveExpiredEntries("2024-07-02T00:00:00.000Z");
      expect(store.count()).toBe(1);

      const result = store.deepArchive("2026-01-01T00:00:00.000Z");

      expect(result.archivedCount).toBe(2);
      expect(result.archivedEntryIds).toEqual(
        expect.arrayContaining([veryOldEntry.id, oldEntry.id]),
      );
      expect(store.count()).toBe(1);
      expect(store.list()[0].id).toBe(recentEntry.id);
      expect(store.assertIntegrity()).toBe(true);
    });

    it("throws on invalid cutoff timestamp", () => {
      const store = new AppendOnlyAuditLogStore();
      expect(() => store.deepArchive("not-a-date")).toThrow("INVALID_ARCHIVE_CUTOFF");
    });

    it("accumulates entries across multiple archive calls", () => {
      const store = new AppendOnlyAuditLogStore();

      const entry1 = store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-acc-1",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-01-01T10:00:00.000Z",
      });

      const entry2 = store.append({
        action: "stream.withdraw",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "withdrawn" },
        before: { status: "ended" },
        requestId: "req-acc-2",
        target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
        timestamp: "2025-03-01T10:00:00.000Z",
      });

      store.deepArchive("2025-02-01T00:00:00.000Z");
      expect(store.getDeepArchivedEntries()).toHaveLength(1);

      store.deepArchive("2025-04-01T00:00:00.000Z");
      expect(store.getDeepArchivedEntries()).toHaveLength(2);
      expect(store.getDeepArchivedEntries().map((de) => de.entry.id)).toEqual([
        entry1.id,
        entry2.id,
      ]);
    });
  });

  describe("exportArchivedRows", () => {
    function makeStore() {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.settle",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "ended" },
        before: { status: "active" },
        requestId: "req-arch-old",
        target: { account: "acct_sensitive_old", id: "stream-1", type: "stream" },
        timestamp: "2024-01-01T10:00:00.000Z",
      });
      store.append({
        action: "stream.withdraw",
        actor: { id: "ops-admin-1", role: "admin" },
        after: { status: "withdrawn" },
        before: { status: "ended" },
        requestId: "req-arch-new",
        target: { account: "acct_demo_001", id: "stream-2", type: "stream" },
        timestamp: "2024-01-02T10:00:00.000Z",
      });
      return store;
    }

    it("returns archived entries (soft + deep) with the redacted projection", () => {
      const store = makeStore();

      // Soft-archive the older entry via retention expiry.
      store.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
      // Deep-archive the soft-archived entry into cold storage.
      store.deepArchive("2025-01-01T00:00:00.000Z");

      const rows = store.exportArchivedRows();

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.requestId)).toEqual([
        "req-arch-new",
        "req-arch-old",
      ]);
      for (const row of rows) {
        expect(row.redactionPolicy).toBe("mask-target-account");
        expect(row.redactedTargetAccount).toBeDefined();
        expect(row.redactedTargetAccount).not.toContain("acct_");
      }
      expect(rows.every((row) => row.entryHash)).toBe(true);
    });

    it("redacts target account labels in archived downloads", () => {
      const store = makeStore();
      store.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
      store.deepArchive("2025-01-01T00:00:00.000Z");

      const rows = store.exportArchivedRows();
      const sensitive = rows.find((row) => row.requestId === "req-arch-old");
      expect(sensitive?.redactedTargetAccount).not.toBe("acct_sensitive_old");
      expect(sensitive?.redactedTargetAccount).toMatch(/\*{3}/);
    });

    it("orders rows newest-first and caps by limit", () => {
      const store = makeStore();
      store.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
      store.deepArchive("2025-01-01T00:00:00.000Z");

      const rows = store.exportArchivedRows(1);
      expect(rows).toHaveLength(1);
      expect(rows[0].requestId).toBe("req-arch-new");
    });

    it("clamps the limit to 1..250", () => {
      const store = makeStore();
      store.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
      store.deepArchive("2025-01-01T00:00:00.000Z");

      expect(store.exportArchivedRows(0)).toHaveLength(1);
      expect(store.exportArchivedRows(9999)).toHaveLength(2);
    });

    it("returns an empty array when nothing is archived", () => {
      const store = new AppendOnlyAuditLogStore();
      expect(store.exportArchivedRows()).toEqual([]);
    });

    it("is deterministic for identical state", () => {
      const store = makeStore();
      store.archiveExpiredEntries("2024-01-15T00:00:00.000Z");
      store.deepArchive("2025-01-01T00:00:00.000Z");

      expect(store.exportArchivedRows()).toEqual(store.exportArchivedRows());
    });
  });

  describe("getPaginated cursor pagination", () => {
    it("returns paginated results with hasNext and nextCursor", () => {
      const store = new AppendOnlyAuditLogStore();
      for (let i = 0; i < 5; i++) {
        store.append({
          action: "stream.create",
          actor: { id: "actor-1", role: "admin" },
          requestId: `req-page-${i}`,
          target: { id: `stream-${i}`, type: "stream" },
          timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
        });
      }

      const page1 = store.getPaginated({ limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.hasNext).toBe(true);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.total).toBe(5);
    });

    it("returns the next page using cursor", () => {
      const store = new AppendOnlyAuditLogStore();
      for (let i = 0; i < 5; i++) {
        store.append({
          action: "stream.create",
          actor: { id: "actor-1", role: "admin" },
          requestId: `req-cur-${i}`,
          target: { id: `stream-${i}`, type: "stream" },
          timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
        });
      }

      const page1 = store.getPaginated({ limit: 2 });
      const page2 = store.getPaginated({ limit: 2, cursor: page1.nextCursor! });
      expect(page2.data).toHaveLength(2);
      // No overlap between pages
      const ids1 = new Set(page1.data.map((e) => e.id));
      for (const e of page2.data) {
        expect(ids1.has(e.id)).toBe(false);
      }
    });

    it("clamps limit to 1..250", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-clamp",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });

      const r1 = store.getPaginated({ limit: 0 });
      expect(r1.data).toHaveLength(1); // clamped to 1

      const r2 = store.getPaginated({ limit: 9999 });
      expect(r2.data.length).toBeLessThanOrEqual(250);
    });

    it("returns hasNext=false on last page", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.settle",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-last",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });

      const result = store.getPaginated({ limit: 50 });
      expect(result.hasNext).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("getCheckpoints", () => {
    it("returns empty array before any purge", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-cp",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      expect(store.getCheckpoints()).toEqual([]);
    });

    it("is cleared on reset", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([{
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-reset-cp",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2022-01-01T10:00:00.000Z",
      }, {
        action: "stream.settle",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-reset-cp2",
        target: { id: "stream-2", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      }]);
      store.purgeArchivedRows("2025-01-01T00:00:00.000Z", true);
      expect(store.getCheckpoints()).toHaveLength(1);

      store.reset();
      expect(store.getCheckpoints()).toHaveLength(0);
    });
  });

  describe("resolveAuditActor and buildRequestId", () => {
    it("resolveAuditActor falls back to system:mock with no auth", () => {
      const { resolveAuditActor } = require("./audit-log");
      const req = new Request("https://example.com/api/test");
      const actor = resolveAuditActor(req);
      expect(actor).toEqual({ id: "system:mock", role: "system" });
    });

    it("resolveAuditActor uses header role/actorId when valid", () => {
      const { resolveAuditActor } = require("./audit-log");
      const req = new Request("https://example.com/api/test", {
        headers: {
          "x-streampay-actor-role": "admin",
          "x-streampay-actor-id": "actor-header-1",
        },
      });
      const actor = resolveAuditActor(req);
      expect(actor).toEqual({ id: "actor-header-1", role: "admin" });
    });

    it("resolveAuditActor ignores invalid role from header", () => {
      const { resolveAuditActor } = require("./audit-log");
      const req = new Request("https://example.com/api/test", {
        headers: {
          "x-streampay-actor-role": "hacker",
          "x-streampay-actor-id": "actor-bad",
        },
      });
      const actor = resolveAuditActor(req);
      expect(actor).toEqual({ id: "system:mock", role: "system" });
    });

    it("buildRequestId uses x-request-id header when present", () => {
      const { buildRequestId } = require("./audit-log");
      const req = new Request("https://example.com/", {
        headers: { "x-request-id": "req-known-id" },
      });
      expect(buildRequestId(req)).toBe("req-known-id");
    });

    it("buildRequestId falls back to mock id when no headers", () => {
      const { buildRequestId } = require("./audit-log");
      const req = new Request("https://example.com/");
      const id = buildRequestId(req);
      expect(id).toMatch(/^mock-request-/);
    });
  });

  describe("edge cases", () => {
    it("purgeArchivedRows returns checkpointId null when nothing to purge", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([{
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-nopur",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      }]);
      const result = store.purgeArchivedRows("2020-01-01T00:00:00.000Z", true);
      expect(result.purgedEntries).toBe(0);
      expect(result.checkpointId).toBeNull();
    });

    it("deepArchive returns checkpointId null when nothing to archive", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-noarch",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      });
      const result = store.deepArchive("2020-01-01T00:00:00.000Z");
      expect(result.archivedCount).toBe(0);
      expect(result.checkpointId).toBeNull();
    });

    it("assertIntegrity returns true on empty store", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      expect(store.assertIntegrity()).toBe(true);
    });

    it("getPaginated returns all results when count is less than limit", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-few",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      const result = store.getPaginated({ limit: 50 });
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.hasNext).toBe(false);
    });

    it("q filter searches across actor, action, and target fields", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      store.append({
        action: "stream.settle",
        actor: { id: "unique-actor-xyz", role: "admin" },
        requestId: "req-qfilter",
        target: { id: "stream-q", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      const results = store.list({ q: "unique-actor-xyz" });
      expect(results).toHaveLength(1);
      const none = store.list({ q: "zzznomatch" });
      expect(none).toHaveLength(0);
    });

    it("getPaginated handles invalid cursor gracefully", () => {
      const store = new AppendOnlyAuditLogStore();
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-badcursor",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      // Invalid base64 cursor should not throw
      expect(() => store.getPaginated({ cursor: "!!!invalid!!!" })).not.toThrow();
    });

    it("restoreArchivedEntries returns empty when nothing archived", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      const restored = store.restoreArchivedEntries();
      expect(restored).toEqual([]);
    });

    it("count returns number of active entries", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      expect(store.count()).toBe(0);
      store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-count",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      expect(store.count()).toBe(1);
    });

    it("updateEntry and deleteEntry always throw AUDIT_LOG_APPEND_ONLY", () => {
      const store = new AppendOnlyAuditLogStore();
      expect(() => store.updateEntry("any-id", {})).toThrow("AUDIT_LOG_APPEND_ONLY");
      expect(() => store.deleteEntry("any-id")).toThrow("AUDIT_LOG_APPEND_ONLY");
    });

    it("recordPrivilegedStreamAuditEvent appends to global store", () => {
      const { recordPrivilegedStreamAuditEvent, resetAuditLogStore } = require("./audit-log");
      resetAuditLogStore();
      const req = new Request("https://example.com/api/test", {
        headers: { "x-request-id": "req-priv-event" },
      });
      const entry = recordPrivilegedStreamAuditEvent({
        request: req,
        action: "stream.stop.override",
        before: { status: "active" },
        after: { status: "ended" },
        streamId: "stream-priv-1",
        targetAccount: "acct_priv",
      });
      expect(entry.action).toBe("stream.stop.override");
      expect(entry.requestId).toBe("req-priv-event");
      expect(entry.target.id).toBe("stream-priv-1");
      resetAuditLogStore();
    });

    it("deepArchive archives from soft-archived entries too and creates checkpoint", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([{
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-soft-arch",
        target: { id: "stream-old", type: "stream" },
        timestamp: "2022-01-01T10:00:00.000Z",
      }, {
        action: "stream.settle",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-fresh-arch",
        target: { id: "stream-new", type: "stream" },
        timestamp: "2026-06-01T10:00:00.000Z",
      }]);

      store.archiveExpiredEntries("2023-01-01T00:00:00.000Z");
      expect(store.getArchivedEntries()).toHaveLength(1);

      const result = store.deepArchive("2023-06-01T00:00:00.000Z");
      expect(result.archivedCount).toBe(1);
      expect(result.checkpointId).not.toBeNull();
      expect(store.getDeepArchivedEntries()).toHaveLength(1);
      expect(store.getArchivedEntries()).toHaveLength(0);
      expect(store.assertIntegrity()).toBe(true);
    });

    it("append uses diffHash from input when provided", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      const entry = store.append({
        action: "stream.create",
        actor: { id: "actor-1", role: "admin" },
        requestId: "req-diffhash",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
        diffHash: "custom-diff-hash-value",
      });
      expect(entry.diffHash).toBe("custom-diff-hash-value");
    });

    it("append entry with no before/after has null diffHash", () => {
      const store = new AppendOnlyAuditLogStore();
      store.reset([]);
      const entry = store.append({
        action: "stream.ping",
        actor: { id: "actor-1", role: "system" },
        requestId: "req-nodiff",
        target: { id: "stream-1", type: "stream" },
        timestamp: "2026-01-01T10:00:00.000Z",
      });
      expect(entry.diffHash).toBeNull();
    });

    it("getPaginated cursor exact match advances past matched entry", () => {
      const store = new AppendOnlyAuditLogStore();
      for (let i = 0; i < 4; i++) {
        store.append({
          action: "stream.create",
          actor: { id: "actor-1", role: "admin" },
          requestId: `req-exact-${i}`,
          target: { id: `stream-${i}`, type: "stream" },
          timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
        });
      }
      const p1 = store.getPaginated({ limit: 1 });
      expect(p1.data).toHaveLength(1);
      expect(p1.hasNext).toBe(true);
      const p2 = store.getPaginated({ limit: 1, cursor: p1.nextCursor! });
      expect(p2.data).toHaveLength(1);
      expect(p2.data[0].id).not.toBe(p1.data[0].id);
    });
  });
});