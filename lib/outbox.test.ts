/**
 * Focused unit tests for the transactional outbox (lib/outbox.ts).
 *
 * Covers:
 *  - InMemoryOutboxStore: append, listPending (oldest-first), update, get, list, clear
 *  - appendToOutbox(): creates and persists an OutboxEntry
 *  - getOutboxStore / setOutboxStore: module singleton swap
 *  - OutboxDrainWorker.drain(): dispatched, failed, empty-queue, batch-size limit
 *  - OutboxDrainWorker.stats(): correct counts by status
 *  - OutboxDrainWorker.snapshot(): returns full list
 *  - Edge cases: duplicate append, update missing entry, drain errors do not throw
 */

import {
  InMemoryOutboxStore,
  appendToOutbox,
  OutboxDrainWorker,
  getOutboxStore,
  setOutboxStore,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox";
import type { WebhookEndpoint, WebhookEvent } from "../app/lib/webhook-delivery";

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeEndpoint(overrides: Partial<WebhookEndpoint> = {}): WebhookEndpoint {
  return {
    id: "ep-1",
    url: "https://example.com/webhook",
    maxRetries: 3,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    id: "evt-1",
    eventType: "stream.started",
    streamId: "stream-abc",
    data: { amount: 100 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a delivery worker stub that resolves immediately. */
function makePassingWorkerStub() {
  return {
    processDelivery: jest.fn().mockResolvedValue({
      success: true,
      deliveryId: "dlv-x",
      attempts: 1,
      dlqed: false,
    }),
  } as any;
}

/** Create a delivery worker stub that throws. */
function makeThrowingWorkerStub(msg = "network error") {
  return {
    processDelivery: jest.fn().mockRejectedValue(new Error(msg)),
  } as any;
}

// Silence logger output in unit tests.
beforeAll(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryOutboxStore
// ─────────────────────────────────────────────────────────────────────────────

describe("InMemoryOutboxStore", () => {
  let store: InMemoryOutboxStore;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
  });

  function makeEntry(partial: Partial<OutboxEntry> = {}): OutboxEntry {
    const now = new Date().toISOString();
    return {
      id: "entry-1",
      endpoint: makeEndpoint(),
      event: makeEvent(),
      deliveryId: "dlv-1",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      drainAttempts: 0,
      ...partial,
    };
  }

  describe("append", () => {
    it("stores a new entry and allows retrieval", () => {
      const entry = makeEntry();
      store.append(entry);
      expect(store.get("entry-1")).toMatchObject({ id: "entry-1", status: "pending" });
    });

    it("returns a copy — mutations to the input do not affect the store", () => {
      const entry = makeEntry();
      store.append(entry);
      (entry as any).status = "dispatched"; // mutate original
      expect(store.get("entry-1")?.status).toBe("pending");
    });

    it("throws if the same id is appended twice", () => {
      store.append(makeEntry());
      expect(() => store.append(makeEntry())).toThrow(/"entry-1" already exists/);
    });
  });

  describe("listPending", () => {
    it("returns empty array when no entries", () => {
      expect(store.listPending()).toEqual([]);
    });

    it("includes pending and failed entries", () => {
      store.append(makeEntry({ id: "e1", status: "pending" }));
      store.append(makeEntry({ id: "e2", status: "failed" }));
      store.append(makeEntry({ id: "e3", status: "dispatched" }));

      const pending = store.listPending();
      expect(pending).toHaveLength(2);
      expect(pending.map((e) => e.id)).toEqual(expect.arrayContaining(["e1", "e2"]));
    });

    it("excludes dispatched entries", () => {
      store.append(makeEntry({ id: "e1", status: "dispatched" }));
      expect(store.listPending()).toHaveLength(0);
    });

    it("orders entries oldest-first by createdAt", () => {
      const older = makeEntry({
        id: "old",
        createdAt: new Date(1_000_000).toISOString(),
        updatedAt: new Date(1_000_000).toISOString(),
      });
      const newer = makeEntry({
        id: "new",
        createdAt: new Date(2_000_000).toISOString(),
        updatedAt: new Date(2_000_000).toISOString(),
      });

      // Insert newer first to verify sort is by createdAt, not insertion order
      store.append(newer);
      store.append(older);

      const pending = store.listPending();
      expect(pending[0].id).toBe("old");
      expect(pending[1].id).toBe("new");
    });

    it("returns copies — mutations do not affect the store", () => {
      store.append(makeEntry({ id: "e1", status: "pending" }));
      const [copy] = store.listPending();
      (copy as any).status = "dispatched";
      // The store's copy should remain "pending"
      expect(store.get("e1")?.status).toBe("pending");
    });
  });

  describe("update", () => {
    it("overwrites an existing entry", () => {
      const entry = makeEntry({ id: "e1", status: "pending" });
      store.append(entry);

      store.update({ ...entry, status: "dispatched", drainAttempts: 1 });

      const updated = store.get("e1");
      expect(updated?.status).toBe("dispatched");
      expect(updated?.drainAttempts).toBe(1);
    });

    it("throws if the entry does not exist", () => {
      const entry = makeEntry({ id: "missing" });
      expect(() => store.update(entry)).toThrow(/"missing" not found/);
    });
  });

  describe("get", () => {
    it("returns undefined for unknown id", () => {
      expect(store.get("does-not-exist")).toBeUndefined();
    });

    it("returns a copy — mutations do not affect the store", () => {
      store.append(makeEntry({ id: "e1" }));
      const copy = store.get("e1")!;
      (copy as any).status = "dispatched";
      expect(store.get("e1")?.status).toBe("pending");
    });
  });

  describe("list", () => {
    it("returns all entries regardless of status", () => {
      store.append(makeEntry({ id: "e1", status: "pending" }));
      store.append(makeEntry({ id: "e2", status: "dispatched" }));
      store.append(makeEntry({ id: "e3", status: "failed" }));
      expect(store.list()).toHaveLength(3);
    });

    it("returns empty array when empty", () => {
      expect(store.list()).toEqual([]);
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      store.append(makeEntry({ id: "e1" }));
      store.append(makeEntry({ id: "e2" }));
      store.clear();
      expect(store.list()).toEqual([]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendToOutbox
// ─────────────────────────────────────────────────────────────────────────────

describe("appendToOutbox", () => {
  let store: InMemoryOutboxStore;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
  });

  it("creates an entry with status 'pending'", () => {
    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent(), store });
    expect(entry.status).toBe("pending");
  });

  it("stores the correct endpoint and event", () => {
    const endpoint = makeEndpoint({ id: "ep-custom", url: "https://custom.io/hook" });
    const event = makeEvent({ id: "evt-custom", eventType: "stream.settled" });
    const entry = appendToOutbox({ endpoint, event, store });

    expect(entry.endpoint.id).toBe("ep-custom");
    expect(entry.event.id).toBe("evt-custom");
    expect(entry.event.eventType).toBe("stream.settled");
  });

  it("generates a stable deliveryId (non-empty string)", () => {
    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent(), store });
    expect(typeof entry.deliveryId).toBe("string");
    expect(entry.deliveryId.length).toBeGreaterThan(0);
  });

  it("generates unique ids for each call", () => {
    const e1 = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent({ id: "ev1" }), store });
    const e2 = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent({ id: "ev2" }), store });
    expect(e1.id).not.toBe(e2.id);
    expect(e1.deliveryId).not.toBe(e2.deliveryId);
  });

  it("persists the entry in the provided store", () => {
    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent(), store });
    expect(store.get(entry.id)).toBeDefined();
  });

  it("sets drainAttempts to 0", () => {
    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent(), store });
    expect(entry.drainAttempts).toBe(0);
  });

  it("sets createdAt and updatedAt as ISO-8601 strings", () => {
    const before = Date.now();
    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent(), store });
    const after = Date.now();

    const createdMs = new Date(entry.createdAt).getTime();
    expect(createdMs).toBeGreaterThanOrEqual(before);
    expect(createdMs).toBeLessThanOrEqual(after);
    expect(entry.updatedAt).toBe(entry.createdAt);
  });

  it("uses the module singleton when no store is provided", () => {
    const fresh = new InMemoryOutboxStore();
    setOutboxStore(fresh);

    const entry = appendToOutbox({ endpoint: makeEndpoint(), event: makeEvent() });
    expect(fresh.get(entry.id)).toBeDefined();

    // Restore to a clean store after this test.
    setOutboxStore(new InMemoryOutboxStore());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOutboxStore / setOutboxStore
// ─────────────────────────────────────────────────────────────────────────────

describe("getOutboxStore / setOutboxStore", () => {
  it("getOutboxStore returns the current store", () => {
    const initial = getOutboxStore();
    expect(initial).toBeDefined();
  });

  it("setOutboxStore replaces the module singleton", () => {
    const original = getOutboxStore();
    const fresh = new InMemoryOutboxStore();
    setOutboxStore(fresh);

    expect(getOutboxStore()).toBe(fresh);

    // Restore
    setOutboxStore(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OutboxDrainWorker
// ─────────────────────────────────────────────────────────────────────────────

describe("OutboxDrainWorker", () => {
  let store: InMemoryOutboxStore;
  let drainer: OutboxDrainWorker;

  function populate(n: number) {
    for (let i = 0; i < n; i++) {
      appendToOutbox({
        endpoint: makeEndpoint({ id: `ep-${i}` }),
        event: makeEvent({ id: `evt-${i}` }),
        store,
      });
    }
  }

  beforeEach(() => {
    store = new InMemoryOutboxStore();
  });

  describe("drain() — empty queue", () => {
    it("returns zeros and does not throw", async () => {
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const result = await drainer.drain();
      expect(result).toEqual({ dispatched: 0, failed: 0, total: 0 });
      expect(worker.processDelivery).not.toHaveBeenCalled();
    });
  });

  describe("drain() — successful dispatch", () => {
    it("dispatches all pending entries and marks them 'dispatched'", async () => {
      populate(3);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const result = await drainer.drain();

      expect(result.total).toBe(3);
      expect(result.dispatched).toBe(3);
      expect(result.failed).toBe(0);
      expect(worker.processDelivery).toHaveBeenCalledTimes(3);

      // All entries should now be "dispatched"
      store.list().forEach((e) => expect(e.status).toBe("dispatched"));
    });

    it("sets dispatchedAt timestamp after successful dispatch", async () => {
      populate(1);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const before = Date.now();
      await drainer.drain();
      const after = Date.now();

      const entry = store.list()[0];
      expect(entry.dispatchedAt).toBeDefined();
      const dispatchedMs = new Date(entry.dispatchedAt!).getTime();
      expect(dispatchedMs).toBeGreaterThanOrEqual(before);
      expect(dispatchedMs).toBeLessThanOrEqual(after);
    });

    it("increments drainAttempts on each drain cycle", async () => {
      populate(1);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      await drainer.drain();

      const entry = store.list()[0];
      expect(entry.drainAttempts).toBe(1);
    });

    it("passes the stable deliveryId from the entry to the worker", async () => {
      populate(1);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const [outboxEntry] = store.list();
      await drainer.drain();

      expect(worker.processDelivery).toHaveBeenCalledWith(
        outboxEntry.endpoint,
        outboxEntry.event,
        outboxEntry.deliveryId,
      );
    });
  });

  describe("drain() — delivery worker throws", () => {
    it("marks the entry 'failed' and records the error", async () => {
      populate(1);
      const worker = makeThrowingWorkerStub("connection refused");
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const result = await drainer.drain();

      expect(result.failed).toBe(1);
      expect(result.dispatched).toBe(0);

      const entry = store.list()[0];
      expect(entry.status).toBe("failed");
      expect(entry.lastError).toContain("connection refused");
    });

    it("does not throw when the delivery worker throws", async () => {
      populate(1);
      const worker = makeThrowingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      await expect(drainer.drain()).resolves.not.toThrow();
    });

    it("processes remaining entries after one failure", async () => {
      populate(3);
      const worker = {
        processDelivery: jest
          .fn()
          .mockRejectedValueOnce(new Error("first fails"))
          .mockResolvedValue({ success: true, deliveryId: "dlv", attempts: 1 }),
      } as any;
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      const result = await drainer.drain();

      expect(result.total).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.dispatched).toBe(2);
    });

    it("retries failed entries on subsequent drain calls", async () => {
      populate(1);

      // First drain: fails
      const failWorker = makeThrowingWorkerStub();
      const failDrainer = new OutboxDrainWorker({ store, deliveryWorker: failWorker });
      await failDrainer.drain();
      expect(store.list()[0].status).toBe("failed");

      // Second drain: succeeds
      const successWorker = makePassingWorkerStub();
      const successDrainer = new OutboxDrainWorker({ store, deliveryWorker: successWorker });
      const result = await successDrainer.drain();

      expect(result.dispatched).toBe(1);
      expect(store.list()[0].status).toBe("dispatched");
    });
  });

  describe("drain() — batchSize", () => {
    it("processes at most batchSize entries per call", async () => {
      populate(10);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker, batchSize: 4 });

      const result = await drainer.drain();

      expect(result.total).toBe(4); // only 4 picked up
      expect(worker.processDelivery).toHaveBeenCalledTimes(4);
    });

    it("leaves remaining pending entries for the next drain", async () => {
      populate(6);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker, batchSize: 3 });

      await drainer.drain();

      const remaining = store.listPending();
      expect(remaining).toHaveLength(3);
    });
  });

  describe("drain() — ordering", () => {
    it("processes entries in creation order (oldest first)", async () => {
      const dispatchOrder: string[] = [];
      const worker = {
        processDelivery: jest.fn().mockImplementation((_ep: any, ev: WebhookEvent) => {
          dispatchOrder.push(ev.id);
          return Promise.resolve({ success: true, deliveryId: "x", attempts: 1 });
        }),
      } as any;
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });

      // Append in order: older first
      appendToOutbox({
        endpoint: makeEndpoint(),
        event: makeEvent({ id: "evt-A", timestamp: new Date(1_000).toISOString() }),
        store,
      });
      appendToOutbox({
        endpoint: makeEndpoint(),
        event: makeEvent({ id: "evt-B", timestamp: new Date(2_000).toISOString() }),
        store,
      });

      await drainer.drain();

      expect(dispatchOrder[0]).toBe("evt-A");
      expect(dispatchOrder[1]).toBe("evt-B");
    });
  });

  describe("stats()", () => {
    it("returns zero counts on empty store", () => {
      drainer = new OutboxDrainWorker({ store, deliveryWorker: makePassingWorkerStub() });
      expect(drainer.stats()).toEqual({ pending: 0, dispatched: 0, failed: 0, total: 0 });
    });

    it("counts entries by status correctly", async () => {
      populate(3); // 3 pending
      const worker = {
        processDelivery: jest
          .fn()
          .mockResolvedValueOnce({ success: true, deliveryId: "d1", attempts: 1 })
          .mockResolvedValueOnce({ success: true, deliveryId: "d2", attempts: 1 })
          .mockRejectedValueOnce(new Error("fail")),
      } as any;
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });
      await drainer.drain();

      const s = drainer.stats();
      expect(s.dispatched).toBe(2);
      expect(s.failed).toBe(1);
      expect(s.pending).toBe(0);
      expect(s.total).toBe(3);
    });
  });

  describe("snapshot()", () => {
    it("returns all entries including dispatched and failed", async () => {
      populate(2);
      const worker = makePassingWorkerStub();
      drainer = new OutboxDrainWorker({ store, deliveryWorker: worker });
      await drainer.drain();

      const snap = drainer.snapshot();
      expect(snap).toHaveLength(2);
    });

    it("returns empty array when store is empty", () => {
      drainer = new OutboxDrainWorker({ store, deliveryWorker: makePassingWorkerStub() });
      expect(drainer.snapshot()).toEqual([]);
    });
  });
});
