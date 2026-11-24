/** @jest-environment node */

import { setStore } from "@/app/lib/db";
import { createInMemoryPersistenceStore } from "@/app/lib/repositories/in-memory";
import type { ActivityEvent } from "@/app/types/openapi";
import { runBackfill } from "./backfill-activity-timeline";

const makeEvent = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "evt-1",
  type: "stream.created",
  streamId: "stream-1",
  timestamp: "2026-04-28T10:00:00.000Z",
  description: "Stream created",
  ...overrides,
});

describe("backfill-activity-timeline", () => {
  const originalDryRun = process.env.DRY_RUN;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.DRY_RUN;
    exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
    jest.restoreAllMocks();
  });

  it("does not exit the process when imported or executed via runBackfill", async () => {
    const store = createInMemoryPersistenceStore(false);
    setStore(store);

    await runBackfill();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns early with zero counts when the store has no raw events", async () => {
    const store = createInMemoryPersistenceStore(false);
    setStore(store);
    const backfillSpy = jest.spyOn(store.activityTimeline, "backfill");

    const stats = await runBackfill();

    expect(stats.totalRaw).toBe(0);
    expect(stats.projected).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(backfillSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "No raw events found. Nothing to backfill.",
    );
  });

  it("projects seeded raw events and is idempotent on a second run", async () => {
    const store = createInMemoryPersistenceStore(false);
    setStore(store);

    store.streamRepository.activity.append(
      makeEvent({
        id: "evt-1",
        streamId: "stream-1",
        type: "stream.created",
        timestamp: "2026-04-28T10:00:00.000Z",
      }),
    );
    store.streamRepository.activity.append(
      makeEvent({
        id: "evt-2",
        streamId: "stream-2",
        type: "stream.paused",
        timestamp: "2026-04-28T11:00:00.000Z",
      }),
    );

    const backfillSpy = jest.spyOn(store.activityTimeline, "backfill");

    const first = await runBackfill();
    expect(first.totalRaw).toBe(2);
    expect(first.projected).toBe(2);
    expect(first.skipped).toBe(0);
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(store.activityTimeline.length).toBe(2);

    const second = await runBackfill();
    expect(second.totalRaw).toBe(2);
    expect(second.projected).toBe(0);
    expect(second.skipped).toBe(2);
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(store.activityTimeline.length).toBe(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("skips mutating the timeline when DRY_RUN=1", async () => {
    process.env.DRY_RUN = "1";
    const store = createInMemoryPersistenceStore(false);
    setStore(store);

    store.streamRepository.activity.append(makeEvent());
    const backfillSpy = jest.spyOn(store.activityTimeline, "backfill");

    const stats = await runBackfill();

    expect(stats.totalRaw).toBe(1);
    expect(stats.projected).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(backfillSpy).not.toHaveBeenCalled();
    expect(store.activityTimeline.length).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      "[DRY RUN] Would backfill 1 entries into activity_timeline.",
    );
  });

  it("mutates the timeline when DRY_RUN=0", async () => {
    process.env.DRY_RUN = "0";
    const store = createInMemoryPersistenceStore(false);
    setStore(store);

    store.streamRepository.activity.append(makeEvent());
    const backfillSpy = jest.spyOn(store.activityTimeline, "backfill");

    const stats = await runBackfill();

    expect(stats.totalRaw).toBe(1);
    expect(stats.projected).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(backfillSpy).toHaveBeenCalledTimes(1);
    expect(store.activityTimeline.length).toBe(1);
  });
});
