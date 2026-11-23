/**
 * Tests for the append-only stream history store.
 *
 * Covers the full test plan:
 *   #1  Ordering (newest-first, commit order)
 *   #2  Idempotent duplicate id skipped
 *   #4  Pagination: 3 pages over 5 entries, no duplicates
 *   #9  No PII — truncateActor helper, no email/label/memo fields
 */

import {
  createStreamHistoryStore,
  truncateActor,
  type StreamHistoryEntry,
} from "./stream-history";

function entry(
  overrides: Partial<StreamHistoryEntry> & { id: string },
): StreamHistoryEntry {
  return {
    streamId: "stream-test",
    type: "created",
    toStatus: "draft",
    at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("InMemoryStreamHistoryStore", () => {
  describe("append and ordering", () => {
    it("returns entries newest-first", () => {
      const store = createStreamHistoryStore();
      store.append(entry({ id: "a", at: "2026-06-01T10:00:00.000Z" }));
      store.append(entry({ id: "b", at: "2026-06-01T12:00:00.000Z" }));
      store.append(entry({ id: "c", at: "2026-06-01T11:00:00.000Z" }));

      const { data } = store.query({ streamId: "stream-test", limit: 10 });
      expect(data.map((e) => e.id)).toEqual(["b", "c", "a"]);
    });

    it("breaks ties by id descending", () => {
      const store = createStreamHistoryStore();
      store.append(entry({ id: "a", at: "2026-06-01T12:00:00.000Z" }));
      store.append(entry({ id: "z", at: "2026-06-01T12:00:00.000Z" }));

      const { data } = store.query({ streamId: "stream-test", limit: 10 });
      expect(data[0].id).toBe("z");
      expect(data[1].id).toBe("a");
    });

    it("is isolated to the queried streamId", () => {
      const store = createStreamHistoryStore();
      store.append(entry({ id: "s1", streamId: "s1", at: "2026-06-01T10:00:00.000Z" }));
      store.append(entry({ id: "s2", streamId: "s2", at: "2026-06-01T11:00:00.000Z" }));

      expect(store.query({ streamId: "s1", limit: 10 }).data).toHaveLength(1);
      expect(store.query({ streamId: "s2", limit: 10 }).data).toHaveLength(1);
      expect(store.query({ streamId: "unknown", limit: 10 }).data).toHaveLength(0);
    });

    it("returns null nextCursor for an empty stream", () => {
      const store = createStreamHistoryStore();
      const { meta } = store.query({ streamId: "stream-test", limit: 10 });
      expect(meta.nextCursor).toBeNull();
    });
  });

  describe("idempotency (test #2)", () => {
    it("skips duplicate entry id", () => {
      const store = createStreamHistoryStore();
      const e = entry({ id: "dup", at: "2026-06-01T10:00:00.000Z" });
      store.append(e);
      store.append(e); // replay
      store.append(e); // replay again

      const { data } = store.query({ streamId: "stream-test", limit: 10 });
      expect(data).toHaveLength(1);
    });
  });

  describe("cursor pagination (test #4)", () => {
    function seedFive() {
      const store = createStreamHistoryStore();
      for (let i = 1; i <= 5; i++) {
        store.append(entry({ id: `e${i}`, at: `2026-06-0${i}T10:00:00.000Z` }));
      }
      return store;
    }

    it("first page limit=2 returns 2 items and a cursor", () => {
      const store = seedFive();
      const page1 = store.query({ streamId: "stream-test", limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.meta.nextCursor).not.toBeNull();
      // newest first: e5, e4
      expect(page1.data[0].id).toBe("e5");
      expect(page1.data[1].id).toBe("e4");
    });

    it("3 pages over 5 entries — no duplicates (test #4)", () => {
      const store = seedFive();
      const allIds: string[] = [];

      const p1 = store.query({ streamId: "stream-test", limit: 2 });
      allIds.push(...p1.data.map((e) => e.id));
      expect(p1.meta.nextCursor).not.toBeNull();

      const p2 = store.query({ streamId: "stream-test", limit: 2, cursor: p1.meta.nextCursor! });
      allIds.push(...p2.data.map((e) => e.id));
      expect(p2.meta.nextCursor).not.toBeNull();

      const p3 = store.query({ streamId: "stream-test", limit: 2, cursor: p2.meta.nextCursor! });
      allIds.push(...p3.data.map((e) => e.id));
      expect(p3.meta.nextCursor).toBeNull();

      expect(allIds).toHaveLength(5);
      expect(new Set(allIds).size).toBe(5);
    });

    it("last page has null nextCursor", () => {
      const store = seedFive();
      const { data, meta } = store.query({ streamId: "stream-test", limit: 10 });
      expect(data).toHaveLength(5);
      expect(meta.nextCursor).toBeNull();
    });

    it("invalid cursor returns empty page (no throw)", () => {
      const store = seedFive();
      const { data, meta } = store.query({
        streamId: "stream-test",
        limit: 10,
        cursor: "not!base64!!!",
      });
      expect(data).toHaveLength(0);
      expect(meta.nextCursor).toBeNull();
    });
  });

  describe("reset", () => {
    it("clears all entries", () => {
      const store = createStreamHistoryStore();
      store.append(entry({ id: "x1" }));
      store.reset();
      expect(store.query({ streamId: "stream-test", limit: 10 }).data).toHaveLength(0);
    });
  });
});

describe("truncateActor (no PII, test #9)", () => {
  it("returns first 6 chars", () => {
    expect(truncateActor("GABCDEFGHIJK")).toBe("GABCDE");
  });

  it("returns undefined for null", () => {
    expect(truncateActor(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(truncateActor("")).toBeUndefined();
  });

  it("never stores the full wallet address", () => {
    const full = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567890";
    const truncated = truncateActor(full);
    expect(truncated).not.toBe(full);
    expect(truncated!.length).toBe(6);
  });
});
