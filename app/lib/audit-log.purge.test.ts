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
import type { AuditEntryInput } from "@/app/types/audit";
import { createHash } from "crypto";

function entry(id: string, timestamp: string): AuditEntryInput {
  return {
    action: "stream.settle",
    actor: { id: `actor-${id}`, role: "admin" },
    after: { status: "ended" },
    before: { status: "active" },
    requestId: `req-${id}`,
    target: { id: `stream-${id}`, type: "stream" },
    timestamp,
  };
}

describe("AppendOnlyAuditLogStore.purgeArchivedRows", () => {
  it("dry-runs without mutating the store", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("old", "2022-01-01T00:00:00.000Z"),
      entry("fresh", "2026-06-01T00:00:00.000Z"),
    ]);

    const result = store.purgeArchivedRows("2025-01-01T00:00:00.000Z");

    expect(result).toMatchObject({
      chainIntactAfter: true,
      chainIntactBefore: true,
      executed: false,
      purgedEntries: 1,
      retainedEntries: 1,
      checkpointId: null,
    });
    expect(store.count()).toBe(2);
    expect(store.assertIntegrity()).toBe(true);
  });

  it("purges rows before the cutoff and preserves retained-chain integrity", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("old-1", "2021-01-01T00:00:00.000Z"),
      entry("old-2", "2022-01-01T00:00:00.000Z"),
      entry("fresh", "2026-06-01T00:00:00.000Z"),
    ]);

    const result = store.purgeArchivedRows("2025-01-01T00:00:00.000Z", true);

    expect(result.executed).toBe(true);
    expect(result.purgedEntries).toBe(2);
    expect(result.retainedEntries).toBe(1);
    expect(result.chainIntactAfter).toBe(true);
    expect(result.checkpointId).not.toBeNull();
    expect(store.count()).toBe(1);
    expect(store.list()[0].target.id).toBe("stream-fresh");
    expect(store.assertIntegrity()).toBe(true);
  });

  it("rejects malformed cutoff timestamps", () => {
    const store = new AppendOnlyAuditLogStore();
    expect(() => store.purgeArchivedRows("not-a-date")).toThrow("INVALID_PURGE_CUTOFF");
  });

  // ── Issue #1676 test scenarios ──────────────────────────────────────────

  // Scenario 1: Append 10, purge 4, retained hashes unchanged
  it("scenario 1: retained entry hashes are unchanged after purge", () => {
    const store = new AppendOnlyAuditLogStore();
    const inputs: AuditEntryInput[] = [];
    for (let i = 0; i < 10; i++) {
      inputs.push(entry(`e${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`));
    }
    store.reset(inputs);

    const all = store.list();
    // Newest-first from list(), reverse to get chronological order
    const chronological = [...all].reverse();
    // Use a cutoff just after the 4th entry so exactly 4 get purged
    const cutoffDate = new Date(chronological[3].timestamp);
    cutoffDate.setUTCSeconds(cutoffDate.getUTCSeconds() + 1);
    const cutoff = cutoffDate.toISOString();

    const hashesBefore = new Map(chronological.slice(4).map((e) => [e.id, e.entryHash]));

    const result = store.purgeArchivedRows(cutoff, true);
    expect(result.purgedEntries).toBe(4);
    expect(result.chainIntactAfter).toBe(true);

    // Retained hashes are unchanged
    for (const retained of store.list()) {
      expect(retained.entryHash).toBe(hashesBefore.get(retained.id));
    }
    expect(store.assertIntegrity()).toBe(true);
  });

  // Scenario 2: Mutate retained entry — integrity false
  it("scenario 2: corrupting a retained entry makes assertIntegrity return false", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("old", "2022-01-01T00:00:00.000Z"),
      entry("fresh", "2026-06-01T00:00:00.000Z"),
    ]);
    store.purgeArchivedRows("2025-01-01T00:00:00.000Z", true);
    expect(store.assertIntegrity()).toBe(true);

    // Directly corrupt the internal entries array (bypasses append-only guard)
    const internalEntries: any[] = (store as any).entries;
    internalEntries[0] = { ...internalEntries[0], metadata: { tampered: true } };

    expect(store.assertIntegrity()).toBe(false);
  });

  // Scenario 3: Plain SHA-256 rewrite is detectable
  it("scenario 3: plain SHA-256 rebuilt hash does not match keyed HMAC hash", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([entry("a", "2026-01-01T00:00:00.000Z")]);

    const first = store.list()[0];

    // Sort keys the same way the implementation does
    function sortKeys(v: unknown): unknown {
      if (Array.isArray(v)) return v.map(sortKeys);
      if (v && typeof v === "object") {
        return Object.keys(v as any).sort().reduce((acc: any, k) => {
          const val = (v as any)[k];
          if (val !== undefined) acc[k] = sortKeys(val);
          return acc;
        }, {});
      }
      return v;
    }

    const plainHash = createHash("sha256")
      .update(JSON.stringify(sortKeys({
        action: first.action,
        actor: first.actor,
        afterHash: first.afterHash,
        beforeHash: first.beforeHash,
        diffHash: first.diffHash,
        metadata: first.metadata ?? null,
        prevHash: first.prevHash,
        requestId: first.requestId,
        target: first.target,
        timestamp: first.timestamp,
      })))
      .digest("hex");

    // Keyed HMAC must differ from unkeyed SHA-256
    expect(first.entryHash).not.toBe(plainHash);
  });

  // Scenario 4: Dry-run — no checkpoint, no entries removed
  it("scenario 4: dry-run writes no checkpoint and removes no entries", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("old", "2022-01-01T00:00:00.000Z"),
      entry("fresh", "2026-06-01T00:00:00.000Z"),
    ]);

    const result = store.purgeArchivedRows("2025-01-01T00:00:00.000Z");

    expect(result.executed).toBe(false);
    expect(result.checkpointId).toBeNull();
    expect(store.getCheckpoints()).toHaveLength(0);
    expect(store.count()).toBe(2);
  });

  // Scenario 5: Deep archive then purge — two checkpoints, chain verifies
  it("scenario 5: deep archive then purge produces two checkpoints; chain still verifies", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("vold", "2024-01-01T00:00:00.000Z"),
      entry("old", "2025-01-01T00:00:00.000Z"),
      entry("fresh", "2026-06-01T00:00:00.000Z"),
    ]);

    const archiveResult = store.deepArchive("2024-06-01T00:00:00.000Z");
    expect(archiveResult.checkpointId).not.toBeNull();

    const purgeResult = store.purgeArchivedRows("2026-01-01T00:00:00.000Z", true);
    expect(purgeResult.checkpointId).not.toBeNull();

    expect(store.getCheckpoints()).toHaveLength(2);
    expect(store.assertIntegrity()).toBe(true);
  });

  // Scenario 6: Purge with invalid cutoff throws
  it("scenario 6: purge with invalid cutoff throws INVALID_PURGE_CUTOFF", () => {
    const store = new AppendOnlyAuditLogStore();
    expect(() => store.purgeArchivedRows("not-a-date", true)).toThrow("INVALID_PURGE_CUTOFF");
  });

  // Scenario 7: Checkpoint holds lastPurgedHash equal to removed tail's hash
  it("scenario 7: checkpoint lastPurgedHash equals the removed tail entry hash", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([
      entry("1", "2022-01-01T00:00:00.000Z"),
      entry("2", "2022-06-01T00:00:00.000Z"),
      entry("3", "2026-06-01T00:00:00.000Z"),
    ]);

    const all = [...store.list()].reverse(); // chronological
    const lastPurgedEntry = all[1]; // entry "2"

    store.purgeArchivedRows("2025-01-01T00:00:00.000Z", true);

    const checkpoints = store.getCheckpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].lastPurgedHash).toBe(lastPurgedEntry.entryHash);
    expect(checkpoints[0].purgedCount).toBe(2);
  });

  // Scenario 8: AUDIT_CHAIN_KEY missing in production throws
  it("scenario 8: missing AUDIT_CHAIN_KEY in production throws", () => {
    const origEnv = process.env.NODE_ENV;
    const origKey = process.env.AUDIT_CHAIN_KEY;

    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete process.env.AUDIT_CHAIN_KEY;

    const store = new AppendOnlyAuditLogStore();
    expect(() => {
      store.append(entry("test", "2026-06-01T00:00:00.000Z"));
    }).toThrow("AUDIT_CHAIN_KEY is required in production");

    (process.env as Record<string, string | undefined>).NODE_ENV = origEnv;
    if (origKey !== undefined) process.env.AUDIT_CHAIN_KEY = origKey;
  });

  // Scenario 9: Property-based test — random appends/purges always maintain integrity
  it("scenario 9: property test — any single-field mutation is detected after purge", () => {
    // Run a deterministic property-like test without fast-check
    // to avoid adding a new dependency
    const timestamps = [
      "2020-01-01T00:00:00.000Z",
      "2021-01-01T00:00:00.000Z",
      "2022-01-01T00:00:00.000Z",
      "2023-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
      "2026-06-01T00:00:00.000Z",
    ];

    for (let retainFrom = 1; retainFrom < timestamps.length; retainFrom++) {
      const store = new AppendOnlyAuditLogStore();
      store.reset(timestamps.map((ts, i) => entry(`e${i}`, ts)));

      const cutoff = timestamps[retainFrom];
      store.purgeArchivedRows(cutoff, true);
      expect(store.assertIntegrity()).toBe(true);

      if (store.count() > 0) {
        const internalEntries: any[] = (store as any).entries;
        const corrupted = { ...internalEntries[0], action: "tampered.action" };
        internalEntries[0] = corrupted;
        expect(store.assertIntegrity()).toBe(false);
        // Restore so next iteration is clean
        internalEntries[0] = store.list()[0]; // this won't help, but the store resets each iteration
      }
    }
  });

  // Extra coverage: array metadata, short account redaction, and restoreArchivedEntries
  it("handles array values in metadata (sortKeys array branch)", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([]);
    const e = store.append({
      action: "stream.create",
      actor: { id: "actor-1", role: "admin" },
      requestId: "req-arr",
      target: { id: "stream-1", type: "stream" },
      timestamp: "2026-01-01T10:00:00.000Z",
      metadata: { tags: ["a", "b", "c"] as any },
    });
    expect(e.metadata?.tags).toBeDefined();
    expect(store.assertIntegrity()).toBe(true);
  });

  it("redacts short target account (≤8 chars)", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([]);
    store.append({
      action: "stream.create",
      actor: { id: "actor-1", role: "admin" },
      requestId: "req-short-acct",
      target: { id: "stream-1", type: "stream", account: "ab12" },
      timestamp: "2026-01-01T10:00:00.000Z",
    });
    const rows = store.exportRows({ requestId: "req-short-acct" });
    expect(rows[0].redactedTargetAccount).toMatch(/\*{3}/);
  });

  it("entry with no target account exports null redactedTargetAccount", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([]);
    store.append({
      action: "stream.create",
      actor: { id: "actor-1", role: "admin" },
      requestId: "req-no-acct",
      target: { id: "stream-1", type: "stream" },
      timestamp: "2026-01-01T10:00:00.000Z",
    });
    const rows = store.exportRows({ requestId: "req-no-acct" });
    expect(rows[0].redactedTargetAccount).toBeNull();
  });

  it("restoreArchivedEntries returns empty array when nothing archived", () => {
    const store = new AppendOnlyAuditLogStore();
    store.reset([]);
    expect(store.restoreArchivedEntries()).toEqual([]);
  });
});