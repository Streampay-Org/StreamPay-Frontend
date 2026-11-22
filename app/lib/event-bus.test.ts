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
