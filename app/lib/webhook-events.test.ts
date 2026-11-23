import fs from "fs";
import path from "path";
import { describe, it, expect } from "@jest/globals";
import {
  STREAM_LIFECYCLE_EVENT_TYPES,
  toWebhookEvent,
  addToOutbox,
  buildStreamWebhookPayload,
  enqueueStreamLifecycleWebhook,
  type StreamLifecycleAction,
  type StreamLifecycleEventType,
} from "./webhook-outbox";
import * as webhookEventsShim from "./webhook-events";
import * as streamWebhookLifecycleShim from "./stream-webhook-lifecycle";
import * as streamWebhookEventsShim from "./stream-webhook-events";
import type { StreamStatus } from "@/app/types/openapi";

describe("STREAM_LIFECYCLE_EVENT_TYPES", () => {
  it("matches the exact expected list of stream lifecycle webhook event types", () => {
    expect(STREAM_LIFECYCLE_EVENT_TYPES).toEqual([
      "stream.created",
      "stream.paused",
      "stream.resumed",
      "stream.stopped",
      "stream.settled",
      "stream.cancelled",
      "stream.withdrawn",
    ]);
  });
});

describe("toWebhookEvent", () => {
  const cases: Array<{
    name: string;
    before: { status: StreamStatus } | null;
    after: { status: StreamStatus };
    action: StreamLifecycleAction;
    expected: StreamLifecycleEventType | null;
  }> = [
    // create
    {
      name: "create from null -> draft emits stream.created",
      before: null,
      after: { status: "draft" },
      action: "create",
      expected: "stream.created",
    },
    {
      name: "create from null -> active emits stream.created",
      before: null,
      after: { status: "active" },
      action: "create",
      expected: "stream.created",
    },

    // pause
    {
      name: "pause active -> paused emits stream.paused",
      before: { status: "active" },
      after: { status: "paused" },
      action: "pause",
      expected: "stream.paused",
    },
    {
      name: "pause when not going to paused returns null",
      before: { status: "active" },
      after: { status: "active" },
      action: "pause",
      expected: null,
    },
    {
      name: "pause when before is not active returns null",
      before: { status: "paused" },
      after: { status: "paused" },
      action: "pause",
      expected: null,
    },
    {
      name: "pause when before is null returns null",
      before: null,
      after: { status: "paused" },
      action: "pause",
      expected: null,
    },

    // resume
    {
      name: "resume paused -> active emits stream.resumed",
      before: { status: "paused" },
      after: { status: "active" },
      action: "resume",
      expected: "stream.resumed",
    },
    {
      name: "resume when not going to active returns null",
      before: { status: "paused" },
      after: { status: "paused" },
      action: "resume",
      expected: null,
    },
    {
      name: "resume when before is not paused returns null",
      before: { status: "draft" },
      after: { status: "active" },
      action: "resume",
      expected: null,
    },
    {
      name: "resume when before is null returns null",
      before: null,
      after: { status: "active" },
      action: "resume",
      expected: null,
    },

    // stop
    {
      name: "stop active -> ended emits stream.stopped",
      before: { status: "active" },
      after: { status: "ended" },
      action: "stop",
      expected: "stream.stopped",
    },
    {
      name: "stop when not going to ended returns null",
      before: { status: "active" },
      after: { status: "active" },
      action: "stop",
      expected: null,
    },

    // settle
    {
      name: "settle active -> ended emits stream.settled",
      before: { status: "active" },
      after: { status: "ended" },
      action: "settle",
      expected: "stream.settled",
    },
    {
      name: "settle when not going to ended returns null",
      before: { status: "active" },
      after: { status: "paused" },
      action: "settle",
      expected: null,
    },

    // cancel
    {
      name: "cancel active -> cancelled emits stream.cancelled",
      before: { status: "active" },
      after: { status: "cancelled" },
      action: "cancel",
      expected: "stream.cancelled",
    },
    {
      name: "cancel when not going to cancelled returns null",
      before: { status: "active" },
      after: { status: "ended" },
      action: "cancel",
      expected: null,
    },

    // withdraw
    {
      name: "withdraw ended -> withdrawn emits stream.withdrawn",
      before: { status: "ended" },
      after: { status: "withdrawn" },
      action: "withdraw",
      expected: "stream.withdrawn",
    },
    {
      name: "withdraw when not going to withdrawn returns null",
      before: { status: "ended" },
      after: { status: "ended" },
      action: "withdraw",
      expected: null,
    },
  ];

  it.each(cases)("$name", ({ before, after, action, expected }) => {
    expect(toWebhookEvent(before, after, action)).toBe(expected);
  });
});

describe("webhook-outbox re-export shims", () => {
  const shims = [
    { name: "webhook-events", mod: webhookEventsShim },
    { name: "stream-webhook-lifecycle", mod: streamWebhookLifecycleShim },
    { name: "stream-webhook-events", mod: streamWebhookEventsShim },
  ];

  it.each(shims)(
    "$name re-exports identical functions from webhook-outbox",
    ({ mod }) => {
      expect(mod.toWebhookEvent).toBe(toWebhookEvent);
      expect(mod.addToOutbox).toBe(addToOutbox);
      expect(mod.buildStreamWebhookPayload).toBe(buildStreamWebhookPayload);
      expect(mod.enqueueStreamLifecycleWebhook).toBe(
        enqueueStreamLifecycleWebhook,
      );
    },
  );
});

describe("docs/EVENT_TOPICS.md drift check", () => {
  it("documents every stream webhook event suffix as a contract sub-topic except webhook-only stopped", () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), "docs/EVENT_TOPICS.md"),
      "utf8",
    );

    const contractStreamSubTopics = new Set<string>();
    const rowPattern = /^\|\s*`"stream"`\s*\|\s*`"([^"]+)"`\s*\|/gm;
    let match: RegExpExecArray | null;
    while ((match = rowPattern.exec(doc)) !== null) {
      contractStreamSubTopics.add(match[1]);
    }

    expect(contractStreamSubTopics.size).toBeGreaterThan(0);

    // `stopped` is a webhook-only lifecycle event (triggered when a stream is
    // stopped via the API) and does not have a corresponding on-chain contract
    // sub-topic in docs/EVENT_TOPICS.md.
    const webhookOnlySuffixes = new Set<string>(["stopped"]);

    for (const eventType of STREAM_LIFECYCLE_EVENT_TYPES) {
      expect(eventType.startsWith("stream.")).toBe(true);
      const suffix = eventType.slice("stream.".length);

      if (webhookOnlySuffixes.has(suffix)) {
        expect(contractStreamSubTopics.has(suffix)).toBe(false);
      } else {
        expect(contractStreamSubTopics.has(suffix)).toBe(true);
      }
    }
  });
});
