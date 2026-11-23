import {
  activityEventToTimelineEntry,
  createActivityTimelineStore,
  mergeActivityTimelinePages,
} from "./activity-timeline";
import type { ActivityEvent } from "@/app/types/openapi";

function makeEvent(overrides: Partial<ActivityEvent> & { id: string }): ActivityEvent {
  return {
    type: "test.event",
    timestamp: "2026-06-01T00:00:00Z",
    description: "Test event",
    ...overrides,
  };
}

function seedEvents(
  store: ReturnType<typeof createActivityTimelineStore>,
  events: ActivityEvent[],
): void {
  for (const event of events) {
    store.append(activityEventToTimelineEntry(event, event.timestamp));
  }
}

describe("ActivityTimelineStore", () => {
  describe("append and order", () => {
    it("maintains descending timestamp order", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "a", timestamp: "2026-06-03T00:00:00Z" }),
        makeEvent({ id: "b", timestamp: "2026-06-01T00:00:00Z" }),
        makeEvent({ id: "c", timestamp: "2026-06-02T00:00:00Z" }),
      ]);

      const result = store.query({ limit: 10 });
      expect(result.data.map((e) => e.id)).toEqual(["a", "c", "b"]);
    });

    it("breaks timestamp ties by id descending", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "b-first", timestamp: "2026-06-01T12:00:00Z" }),
        makeEvent({ id: "a-second", timestamp: "2026-06-01T12:00:00Z" }),
        makeEvent({ id: "c-third", timestamp: "2026-06-01T11:00:00Z" }),
      ]);

      const result = store.query({ limit: 10 });
      expect(result.data[0].id).toBe("b-first");
      expect(result.data[1].id).toBe("a-second");
      expect(result.data[2].id).toBe("c-third");
    });

    it("handles single event", () => {
      const store = createActivityTimelineStore();
      store.append(activityEventToTimelineEntry(
        makeEvent({ id: "only-one" }),
        "2026-06-01T00:00:00Z",
      ));

      expect(store.length).toBe(1);
      expect(store.query({ limit: 10 }).data).toHaveLength(1);
    });
  });

  describe("query filtering", () => {
    it("filters by streamId", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "a", streamId: "s1" }),
        makeEvent({ id: "b", streamId: "s2" }),
        makeEvent({ id: "c", streamId: "s1" }),
      ]);

      const result = store.query({ limit: 10, streamId: "s1" });
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.data.every((e) => e.streamId === "s1")).toBe(true);
    });

    it("filters by type", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "a", type: "type.x" }),
        makeEvent({ id: "b", type: "type.y" }),
        makeEvent({ id: "c", type: "type.x" }),
      ]);

      const result = store.query({ limit: 10, type: "type.x" });
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
    });

    it("combines streamId and type filters", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "a", type: "t1", streamId: "s1" }),
        makeEvent({ id: "b", type: "t2", streamId: "s1" }),
        makeEvent({ id: "c", type: "t1", streamId: "s2" }),
      ]);

      const result = store.query({ limit: 10, streamId: "s1", type: "t1" });
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("a");
    });

    it("returns empty for non-matching filter", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [makeEvent({ id: "a", streamId: "s1" })]);

      const result = store.query({ limit: 10, streamId: "nonexistent" });
      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
    });
  });

  describe("cursor-based pagination", () => {
    it("paginates forward through all events", () => {
      const store = createActivityTimelineStore();
      const events = [
        makeEvent({ id: "evt-1", timestamp: "2026-06-05T00:00:00Z" }),
        makeEvent({ id: "evt-2", timestamp: "2026-06-04T00:00:00Z" }),
        makeEvent({ id: "evt-3", timestamp: "2026-06-03T00:00:00Z" }),
        makeEvent({ id: "evt-4", timestamp: "2026-06-02T00:00:00Z" }),
        makeEvent({ id: "evt-5", timestamp: "2026-06-01T00:00:00Z" }),
      ];
      seedEvents(store, events);

      const allIds: string[] = [];
      let cursor: string | undefined;

      for (let i = 0; i < 10; i++) {
        const result = store.query({ limit: 2, cursor });
        allIds.push(...result.data.map((e) => e.id));
        cursor = result.meta.nextCursor ?? undefined;
        if (!result.meta.hasNext) break;
      }

      expect(allIds).toEqual(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]);
    });

    it("returns null cursor on last page", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [makeEvent({ id: "only-one" })]);

      const result = store.query({ limit: 10 });
      expect(result.meta.hasNext).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it("does not repeat or drop same-timestamp events across pages", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "evt-c", timestamp: "2026-06-01T12:00:00Z" }),
        makeEvent({ id: "evt-b", timestamp: "2026-06-01T12:00:00Z" }),
        makeEvent({ id: "evt-a", timestamp: "2026-06-01T12:00:00Z" }),
      ]);

      const first = store.query({ limit: 2 });
      const second = store.query({ limit: 2, cursor: first.meta.nextCursor ?? undefined });

      expect(first.data.map((event) => event.id)).toEqual(["evt-c", "evt-b"]);
      expect(second.data.map((event) => event.id)).toEqual(["evt-a"]);
    });
  });

  describe("request-scoped predicate", () => {
    function scopedEvent(
      id: string,
      timestamp: string,
      overrides: Partial<ActivityEvent> = {},
    ): ActivityEvent {
      return makeEvent({ id, timestamp, ...overrides });
    }

    it("computes total and hasNext on the scoped set only", () => {
      const store = createActivityTimelineStore();
      const visible = Array.from({ length: 5 }, (_, i) =>
        scopedEvent(`a-${i}`, `2026-06-${String(20 - i).padStart(2, "0")}T00:00:00Z`, {
          streamId: "owned",
        }),
      );
      const hidden = Array.from({ length: 25 }, (_, i) =>
        scopedEvent(`b-${i}`, `2026-05-${String(28 - (i % 28)).padStart(2, "0")}T00:00:00Z`, {
          streamId: "other",
        }),
      );
      seedEvents(store, [...visible, ...hidden]);

      const first = store.query({
        limit: 2,
        predicate: (entry) => entry.streamId === "owned",
      });

      expect(first.meta.total).toBe(5);
      expect(first.meta.hasNext).toBe(true);
      expect(first.data).toHaveLength(2);
      expect(first.data.every((entry) => entry.streamId === "owned")).toBe(true);

      const second = store.query({
        limit: 2,
        cursor: first.meta.nextCursor ?? undefined,
        predicate: (entry) => entry.streamId === "owned",
      });

      expect(second.meta.total).toBe(5);
      expect(second.meta.hasNext).toBe(true);
      expect(second.data.every((entry) => entry.streamId === "owned")).toBe(true);
    });

    it("paginates the scoped set across 3 pages without duplicates or gaps", () => {
      const store = createActivityTimelineStore();
      const visible = Array.from({ length: 5 }, (_, i) =>
        scopedEvent(`a-${i}`, `2026-06-${String(20 - i).padStart(2, "0")}T00:00:00Z`, {
          streamId: "owned",
        }),
      );
      const hidden = Array.from({ length: 10 }, (_, i) =>
        scopedEvent(`b-${i}`, `2026-06-${String(20 - i).padStart(2, "0")}T12:00:00Z`, {
          streamId: "other",
        }),
      );
      seedEvents(store, [...visible, ...hidden]);

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 3; i++) {
        const result = store.query({
          limit: 2,
          cursor,
          predicate: (entry) => entry.streamId === "owned",
        });
        expect(result.meta.total).toBe(5);
        seen.push(...result.data.map((entry) => entry.id));
        cursor = result.meta.nextCursor ?? undefined;
      }

      expect(seen).toEqual(["a-0", "a-1", "a-2", "a-3", "a-4"]);
      expect(new Set(seen).size).toBe(5);
      expect(cursor).toBeUndefined();
    });

    it("combines the predicate with existing streamId and type filters", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        scopedEvent("visible", "2026-06-03T00:00:00Z", {
          streamId: "s1",
          type: "stream.created",
        }),
        scopedEvent("wrong-type", "2026-06-02T00:00:00Z", {
          streamId: "s1",
          type: "stream.stopped",
        }),
        scopedEvent("scoped-out", "2026-06-01T00:00:00Z", {
          streamId: "s2",
          type: "stream.created",
        }),
      ]);

      const result = store.query({
        limit: 10,
        streamId: "s1",
        type: "stream.created",
        predicate: (entry) => entry.id !== "scoped-out",
      });

      expect(result.data.map((entry) => entry.id)).toEqual(["visible"]);
      expect(result.meta.total).toBe(1);
    });

    it("returns an empty scoped page with total 0 when nothing is visible", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        scopedEvent("hidden-a", "2026-06-02T00:00:00Z", { streamId: "other" }),
        scopedEvent("hidden-b", "2026-06-01T00:00:00Z", { streamId: "other" }),
      ]);

      const result = store.query({ limit: 10, predicate: () => false });

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasNext).toBe(false);
      expect(result.meta.nextCursor).toBeNull();
    });

    it("propagates actorAddress for non-stream events", () => {
      const entry = activityEventToTimelineEntry(
        makeEvent({
          id: "wallet-event",
          type: "wallet.connected",
          actorAddress: "GALICE",
        }),
        "2026-06-01T00:00:00Z",
      );

      expect(entry.actorAddress).toBe("GALICE");
    });
  });

  describe("mergeActivityTimelinePages", () => {
    it("deduplicates and sorts paged timeline responses deterministically", () => {
      const entry = (id: string, timestamp: string) =>
        activityEventToTimelineEntry(makeEvent({ id, timestamp }), timestamp);

      const merged = mergeActivityTimelinePages([
        [entry("evt-2", "2026-06-01T12:00:00Z"), entry("evt-1", "2026-06-01T13:00:00Z")],
        [entry("evt-3", "2026-06-01T12:00:00Z"), entry("evt-2", "2026-06-01T12:00:00Z")],
      ]);

      expect(merged.map((event) => event.id)).toEqual(["evt-1", "evt-3", "evt-2"]);
    });
  });

  describe("lag metric", () => {
    it("returns 0 for empty store", () => {
      const store = createActivityTimelineStore();
      expect(store.getLagMs()).toBe(0);
    });

    it("returns positive lag for past events", () => {
      const store = createActivityTimelineStore();
      const past = new Date(Date.now() - 5000).toISOString();
      store.append(activityEventToTimelineEntry(
        makeEvent({ id: "past-event", timestamp: past }),
        past,
      ));

      const lag = store.getLagMs();
      expect(lag).toBeGreaterThan(4000);
      expect(lag).toBeLessThan(10000);
    });
  });

  describe("backfill", () => {
    it("replaces all entries with sorted data", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "old", timestamp: "2026-06-01T00:00:00Z" }),
      ]);

      const entries = [
        makeEvent({ id: "new", timestamp: "2026-06-03T00:00:00Z" }),
        makeEvent({ id: "mid", timestamp: "2026-06-02T00:00:00Z" }),
      ].map((e) => activityEventToTimelineEntry(e, e.timestamp));

      store.backfill(entries);

      expect(store.length).toBe(2);
      expect(store.query({ limit: 10 }).data.map((e) => e.id)).toEqual(["new", "mid"]);
    });

    it("handles empty backfill", () => {
      const store = createActivityTimelineStore();
      store.backfill([]);
      expect(store.length).toBe(0);
    });
  });

  describe("getLatestProjectedTimestamp", () => {
    it("returns null for empty store", () => {
      const store = createActivityTimelineStore();
      expect(store.getLatestProjectedTimestamp()).toBeNull();
    });

    it("returns the timestamp of the first (newest) entry", () => {
      const store = createActivityTimelineStore();
      seedEvents(store, [
        makeEvent({ id: "a", timestamp: "2026-06-05T00:00:00Z" }),
        makeEvent({ id: "b", timestamp: "2026-06-03T00:00:00Z" }),
      ]);
      expect(store.getLatestProjectedTimestamp()).toBe("2026-06-05T00:00:00Z");
    });
  });

  describe("reset", () => {
    it("clears all entries", () => {
      const store = createActivityTimelineStore();
      store.append(activityEventToTimelineEntry(
        makeEvent({ id: "a" }),
        "2026-06-01T00:00:00Z",
      ));
      expect(store.length).toBe(1);

      store.reset();
      expect(store.length).toBe(0);
      expect(store.query({ limit: 10 }).data).toHaveLength(0);
    });
  });
});
