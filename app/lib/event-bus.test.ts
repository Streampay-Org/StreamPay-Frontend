import {
  eventBus,
  type SettleFinishedPayload,
  type StreamUpdatedPayload,
} from "./event-bus";
import type { ActivityEvent } from "@/app/types/openapi";

function makeStreamPayload(
  overrides: Partial<StreamUpdatedPayload> = {},
): StreamUpdatedPayload {
  return {
    id: "stream-1",
    recipient: "GABCD1234",
    rate: "100 XLM / month",
    schedule: "Pays every 30 days",
    status: "active",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-02T00:00:00Z",
    token: "XLM",
    ...overrides,
  };
}

describe("StreamEventBus", () => {
  it("emits and receives typed stream:updated events and removes listener with offStreamUpdated", () => {
    const streamId = "stream-updated-test";
    const payload = makeStreamPayload({ id: streamId });
    const handler = jest.fn();

    eventBus.onStreamUpdated(streamId, handler);
    eventBus.emitStreamUpdated(streamId, payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);

    eventBus.offStreamUpdated(streamId, handler);
    eventBus.emitStreamUpdated(streamId, payload);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits and receives typed settle:finished events and removes listener with offSettleFinished", () => {
    const streamId = "settle-finished-test";
    const payload: SettleFinishedPayload = makeStreamPayload({
      id: streamId,
      status: "ended",
      settlementTxHash: "tx-hash-123",
    });
    const handler = jest.fn();

    eventBus.onSettleFinished(streamId, handler);
    eventBus.emitSettleFinished(streamId, payload);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);

    eventBus.offSettleFinished(streamId, handler);
    eventBus.emitSettleFinished(streamId, payload);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits and receives typed activity events", () => {
    const event: ActivityEvent = {
      id: "activity-1",
      type: "stream.start",
      streamId: "stream-1",
      timestamp: "2026-04-02T00:00:00Z",
      description: "Stream stream-1 started",
    };
    const handler = jest.fn();

    eventBus.onActivityEvent(handler);
    try {
      eventBus.emitActivityEvent(event);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    } finally {
      eventBus.off("activity:new", handler);
    }
  });

  it("supports multiple listeners for the same stream id and removes only the unsubscribed one", () => {
    const streamId = "multi-listener-stream";
    const payload = makeStreamPayload({ id: streamId });
    const listenerA = jest.fn();
    const listenerB = jest.fn();

    eventBus.onStreamUpdated(streamId, listenerA);
    eventBus.onStreamUpdated(streamId, listenerB);

    eventBus.emitStreamUpdated(streamId, payload);
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    eventBus.offStreamUpdated(streamId, listenerA);
    eventBus.emitStreamUpdated(streamId, payload);

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(2);

    eventBus.offStreamUpdated(streamId, listenerB);
  });
});
/** @jest-environment node */

jest.mock("@/app/lib/db", () => ({
  getStore: jest.fn(),
}));

import { getStore } from "@/app/lib/db";
import { eventBus } from "./event-bus";
import { activityEventToTimelineEntry } from "@/app/lib/repositories/activity-timeline";

const mockedGetStore = getStore as jest.Mock;

function makeActivityEvent(
  overrides: Partial<ActivityEvent> = {},
): ActivityEvent {
    id: "evt-1",
    type: "stream.start",
    streamId: "stream-1",
    actorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    timestamp: "2026-01-01T00:00:00.000Z",
    description: "Stream started",
  };
}

describe("eventBus", () => {
  let appendMock: jest.Mock;

  beforeEach(() => {
    appendMock = jest.fn();
    mockedGetStore.mockReset();
    mockedGetStore.mockReturnValue({
      activityTimeline: {
        append: appendMock,
      },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("projects an emitted activity event onto the timeline store", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const event = makeActivityEvent();

    eventBus.emitActivityEvent(event);

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      activityEventToTimelineEntry(event),
    );
  });

  it("projects an activity event with missing optional fields", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
      id: "evt-minimal",
      type: "system.notice",
      timestamp: "2026-01-01T00:00:00.000Z",
      description: "Minimal event",
    };

    eventBus.emitActivityEvent(event);

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      activityEventToTimelineEntry(event),
    );
  });

  it("swallows errors thrown by getStore and continues projecting later events", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    mockedGetStore.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });

    const firstEvent = makeActivityEvent({ id: "evt-fail-store" });
    const secondEvent = makeActivityEvent({ id: "evt-recover-store" });

    expect(() => eventBus.emitActivityEvent(firstEvent)).not.toThrow();
    expect(appendMock).not.toHaveBeenCalled();

    eventBus.emitActivityEvent(secondEvent);

    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledWith(
      activityEventToTimelineEntry(secondEvent),
    );
  });

  it("swallows errors thrown by activityTimeline.append and continues projecting later events", () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    appendMock.mockImplementationOnce(() => {
      throw new Error("append failed");
    });

    const firstEvent = makeActivityEvent({ id: "evt-fail-append" });
    const secondEvent = makeActivityEvent({ id: "evt-recover-append" });

    expect(() => eventBus.emitActivityEvent(firstEvent)).not.toThrow();

    eventBus.emitActivityEvent(secondEvent);

    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(appendMock).toHaveBeenNthCalledWith(
      2,
      activityEventToTimelineEntry(secondEvent),
    );
  });

  it("notifies onActivityEvent subscribers in addition to projecting", () => {
    const received: ActivityEvent[] = [];
    const handler = (event: ActivityEvent) => {
      received.push(event);
    };
    const event = makeActivityEvent({ id: "evt-sub" });


      expect(received).toEqual([event]);
      expect(appendMock).toHaveBeenCalledTimes(1);
    }
  });

  it("invokes a handler registered twice twice and cleans up both registrations", () => {
    const event = makeActivityEvent({ id: "evt-dup" });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, event);
      expect(handler).toHaveBeenNthCalledWith(2, event);
    }

    handler.mockClear();
    eventBus.emitActivityEvent(makeActivityEvent({ id: "evt-after-cleanup" }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("emits stream updates on stream:updated:<id>", () => {
    const otherHandler = jest.fn();
    const payload = { id: "stream-42", status: "active" };

    eventBus.on("stream:updated:stream-42", handler);
    eventBus.on("stream:updated:stream-99", otherHandler);
      eventBus.emitStreamUpdated("stream-42", payload);

      expect(handler).toHaveBeenCalledWith(payload);
      expect(otherHandler).not.toHaveBeenCalled();
      eventBus.off("stream:updated:stream-42", handler);
      eventBus.off("stream:updated:stream-99", otherHandler);
    }
  });

  it("emits settlement completion on settle:finished:<id>", () => {
    const otherHandler = jest.fn();
    const payload = { id: "stream-42", status: "ended", txHash: "tx-1" };

    eventBus.on("settle:finished:stream-42", handler);
    eventBus.on("settle:finished:stream-99", otherHandler);
      eventBus.emitSettleFinished("stream-42", payload);

      expect(handler).toHaveBeenCalledWith(payload);
      expect(otherHandler).not.toHaveBeenCalled();
      eventBus.off("settle:finished:stream-42", handler);
      eventBus.off("settle:finished:stream-99", otherHandler);
    }
  });
});
