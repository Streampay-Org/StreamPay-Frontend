/** @jest-environment node */

import { AppendOnlyAuditLogStore } from "@/app/lib/audit-log";
import {
  DEEP_ARCHIVE_DAYS,
  deepArchiveExpiredEntries,
  getDeepArchivedEntries,
} from "@/lib/auditArchive";

describe("auditArchive convenience module", () => {
  it("exports DEEP_ARCHIVE_DAYS as 180", () => {
    expect(DEEP_ARCHIVE_DAYS).toBe(180);
  });

  it("deepArchiveExpiredEntries archives entries older than 180 days by default", () => {
    const store = new AppendOnlyAuditLogStore();

    store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-180-1",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-01-01T10:00:00.000Z",
    });

    const result = deepArchiveExpiredEntries(store, "2026-07-23T00:00:00.000Z");

    expect(result.archivedCount).toBe(1);
    expect(result.chainIntactAfter).toBe(true);
  });

  it("does not archive entries newer than 180 days", () => {
    const store = new AppendOnlyAuditLogStore();

    store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-recent",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-06-01T10:00:00.000Z",
    });

    const result = deepArchiveExpiredEntries(store, "2026-07-23T00:00:00.000Z");

    expect(result.archivedCount).toBe(0);
  });

  it("getDeepArchivedEntries returns archived entries from the store", () => {
    const store = new AppendOnlyAuditLogStore();

    store.append({
      action: "stream.settle",
      actor: { id: "ops-admin-1", role: "admin" },
      after: { status: "ended" },
      before: { status: "active" },
      requestId: "req-get-archived",
      target: { account: "acct_demo_001", id: "stream-1", type: "stream" },
      timestamp: "2026-01-01T10:00:00.000Z",
    });

    deepArchiveExpiredEntries(store, "2026-07-23T00:00:00.000Z");

    const archived = getDeepArchivedEntries(store);
    expect(archived).toHaveLength(1);
    expect(archived[0].entry.action).toBe("stream.settle");
  });

  it("throws on invalid reference timestamp", () => {
    const store = new AppendOnlyAuditLogStore();
    expect(() => deepArchiveExpiredEntries(store, "nope")).toThrow("INVALID_REFERENCE_TIMESTAMP");
  });

  it("uses the default auditLogStore when no store is provided", () => {
    const result = deepArchiveExpiredEntries();
    expect(result).toBeDefined();
    expect(typeof result.archivedCount).toBe("number");
    expect(typeof result.chainIntactAfter).toBe("boolean");
  });

  it("getDeepArchivedEntries returns empty array when nothing archived", () => {
    const store = new AppendOnlyAuditLogStore();
    expect(getDeepArchivedEntries(store)).toEqual([]);
  });
});
