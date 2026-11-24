/** @jest-environment node */

import { eventBus } from "./event-bus";
import { getStore, resetDb } from "./db";
import {
  hasLifecycleChange,
  inferStreamChangeAction,
  publishStreamChange,
  toPublishedStream,
} from "./stream-publish";
import type { Stream } from "@/app/types/openapi";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream-1",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    rate: "10 XLM / month",
    schedule: "Pays every 30 days",
    status: "active",
    nextAction: "pause",
    email: "pii@example.test",
    label: "PII label",
    memo: "PII memo",
    partnerId: "partner-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    token: "XLM",
    ...overrides,
  };
}

interface Collected {
  detach: () => void;
  activity: Array<Record<string, unknown>>;
  events: string[];
  settled: Array<Record<string, unknown>>;
  updated: Array<Record<string, unknown>>;
}

function collect(streamId: string): Collected {
  const updated: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const events: string[] = [];

  const onUpdated = (data: Record<string, unknown>) => {
    events.push("stream:updated");
    updated.push(data);
  };
  const onSettled = (data: Record<string, unknown>) => {
    events.push("settle:finished");
    settled.push(data);
  };
  const onActivity = (event: Record<string, unknown>) => {
    activity.push(event);
  };

  eventBus.on(`stream:updated:${streamId}`, onUpdated);
  eventBus.on(`settle:finished:${streamId}`, onSettled);
  eventBus.on("activity:new", onActivity);

  return {
    activity,
    detach: () => {
      eventBus.off(`stream:updated:${streamId}`, onUpdated);
      eventBus.off(`settle:finished:${streamId}`, onSettled);
      eventBus.off("activity:new", onActivity);
    },
    events,
    settled,
    updated,
  };
}

describe("stream-publish", () => {
  beforeEach(() => {
    resetDb();
  });

  it("omits every PII field from the published projection", () => {
    const stream = makeStream();
    const published = toPublishedStream(stream);

    expect(published).not.toHaveProperty("email");
    expect(published).not.toHaveProperty("label");
    expect(published).not.toHaveProperty("memo");
    expect(published).not.toHaveProperty("partnerId");
    expect(published.id).toBe(stream.id);
    expect(published.status).toBe("active");
  });

  it("does not treat PII-only or updatedAt-only writes as lifecycle changes", () => {
    const before = makeStream();
    const after = makeStream({
      email: "changed@example.test",
      label: "changed label",
      memo: "changed memo",
      partnerId: "partner-2",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(hasLifecycleChange(before, after)).toBe(false);
  });

  it("detects status and withdrawal lifecycle changes", () => {
    const before = makeStream();

    expect(hasLifecycleChange(before, makeStream({ status: "paused" }))).toBe(true);
    expect(
      hasLifecycleChange(
        before,
        makeStream({
          withdrawal: {
            attempts: 1,
            lastCheckedAt: "2026-01-02T00:00:00.000Z",
            requestedAt: "2026-01-01T00:00:00.000Z",
            state: "pending",
          },
        }),
      ),
    ).toBe(true);
  });

  it("does not emit for a no-op write", () => {
    const collector = collect("stream-1");
    const stream = makeStream();

    try {
      expect(
        publishStreamChange({
          action: "pause",
          after: makeStream({ updatedAt: "2026-01-02T00:00:00.000Z" }),
          before: stream,
        }),
      ).toBe(false);
      expect(collector.events).toEqual([]);
      expect(collector.activity).toEqual([]);
      expect(getStore().activityTimeline.length).toBe(0);
    } finally {
      collector.detach();
    }
  });

  it("publishes a redacted stream update and an activity event", () => {
    const collector = collect("stream-1");
    const before = makeStream({ status: "paused" });
    const after = makeStream({
      status: "active",
      nextAction: "pause",
      pausedAt: undefined,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    try {
      expect(
        publishStreamChange({
          action: "start",
          actor: "GACTOR",
          after,
          before,
          correlationId: "corr-1",
        }),
      ).toBe(true);

      expect(collector.events).toEqual(["stream:updated"]);
      expect(collector.updated).toHaveLength(1);
      expect(collector.updated[0].status).toBe("active");
      expect(collector.updated[0]).not.toHaveProperty("email");
      expect(collector.updated[0]).not.toHaveProperty("label");
      expect(collector.updated[0]).not.toHaveProperty("memo");
      expect(collector.updated[0]).not.toHaveProperty("partnerId");

      expect(collector.activity).toHaveLength(1);
      expect(collector.activity[0]).toMatchObject({
        actor: "GACTOR",
        correlationId: "corr-1",
        streamId: "stream-1",
        type: "stream.start",
      });
      expect(String(collector.activity[0].description)).toContain("started");
      expect(getStore().activityTimeline.length).toBe(1);
    } finally {
      collector.detach();
    }
  });

  it("emits stream:updated before settle:finished for a settle", () => {
    const collector = collect("stream-1");
    const before = makeStream({ status: "active" });
    const after = makeStream({
      settlementTxHash: "tx-1",
      status: "ended",
      updatedAt: "2026-01-02T00:00:00.000Z",
      withdrawal: {
        attempts: 0,
        lastCheckedAt: "2026-01-02T00:00:00.000Z",
        requestedAt: "2026-01-02T00:00:00.000Z",
        settlementTxHash: "tx-1",
        state: "pending",
      },
    });

    try {
      publishStreamChange({
        action: "settle",
        after,
        before,
      });

      expect(collector.events).toEqual(["stream:updated", "settle:finished"]);
      expect(collector.updated[0].status).toBe("ended");
      expect(collector.settled[0].status).toBe("ended");
    } finally {
      collector.detach();
    }
  });

  it("does not emit settle:finished when the stream was already ended", () => {
    const collector = collect("stream-1");
    const before = makeStream({ status: "ended" });
    const after = makeStream({
      status: "ended",
      updatedAt: "2026-01-02T00:00:00.000Z",
      withdrawal: {
        attempts: 1,
        lastCheckedAt: "2026-01-02T00:00:00.000Z",
        requestedAt: "2026-01-01T00:00:00.000Z",
        state: "succeeded",
      },
    });

    try {
      publishStreamChange({ action: "settle", after, before });
      expect(collector.events).toEqual(["stream:updated"]);
    } finally {
      collector.detach();
    }
  });

  it("infers actions for generic updates", () => {
    const active = makeStream();
    const ended = makeStream({ status: "ended" });

    expect(inferStreamChangeAction(active, makeStream({ status: "paused" }))).toBe("pause");
    expect(inferStreamChangeAction(makeStream({ status: "paused" }), active)).toBe("start");
    expect(inferStreamChangeAction(active, makeStream({ status: "cancelled" }))).toBe("cancel");
    expect(inferStreamChangeAction(ended, makeStream({ status: "withdrawn" }))).toBe("withdraw");
    expect(inferStreamChangeAction(active, makeStream({ status: "draft" }))).toBe("update");
    expect(
      inferStreamChangeAction(
        active,
        makeStream({ status: "ended", settlementTxHash: "tx-1" }),
      ),
    ).toBe("settle");
    expect(
      inferStreamChangeAction(
        active,
        makeStream({
          withdrawal: {
            attempts: 1,
            lastCheckedAt: "2026-01-02T00:00:00.000Z",
            requestedAt: "2026-01-01T00:00:00.000Z",
            state: "pending",
          },
        }),
      ),
    ).toBe("withdraw");
  });
});
