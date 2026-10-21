import { GET } from "./route";
import {
  createInMemoryPersistenceStore,
  decodeCompositeCursor,
  encodeCompositeCursor,
  getStore,
  setStore,
} from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { signToken } from "@/app/lib/auth";
import type { ActivityEvent, Stream } from "@/app/types/openapi";
import { activityEventToTimelineEntry } from "@/app/lib/repositories/activity-timeline";

jest.mock("@/app/lib/logger", () => ({
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  withCorrelationContext: jest.fn((ctx, fn) => fn()),
}));

const ALICE = "GALICE0000000000000000000000000000000000000000000000000000";
const BOB = "GBOB000000000000000000000000000000000000000000000000000000";

const defaultEvents: ActivityEvent[] = [
  { id: "evt-1", type: "wallet.connected", actorAddress: ALICE, timestamp: "2026-04-28T09:00:00Z", description: "Wallet connected." },
  { id: "evt-2", type: "stream.created", streamId: "stream-ada", timestamp: "2026-04-27T20:00:00Z", description: "Stream created." },
  { id: "evt-3", type: "stream.started", streamId: "stream-ada", timestamp: "2026-04-15T08:00:00Z", description: "Stream started." },
  { id: "evt-4", type: "stream.created", streamId: "stream-kemi", timestamp: "2026-04-10T14:00:00Z", description: "Stream created." },
  { id: "evt-5", type: "stream.created", streamId: "stream-yusuf", timestamp: "2026-04-01T09:05:00Z", description: "Stream created." },
  { id: "evt-6", type: "stream.stopped", streamId: "stream-yusuf", timestamp: "2026-04-01T09:00:00Z", description: "Stream stopped." },
];

function makeStream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    recipient: "Unowned Recipient",
    rate: "10",
    schedule: "month",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    token: "XLM",
    ...overrides,
  };
}

function seedStreams(): void {
  const streams = getStore().streamRepository.streams;
  streams.clear();
  streams.set("stream-ada", makeStream("stream-ada", { recipient: ALICE }));
  streams.set("stream-kemi", makeStream("stream-kemi", { senderAddress: ALICE }));
  streams.set("stream-yusuf", makeStream("stream-yusuf", { senderAddress: ALICE }));
  streams.set("stream-bob", makeStream("stream-bob", { recipient: BOB }));
}

function seedActivity(events: ActivityEvent[] = defaultEvents) {
  const store = getStore();
  store.activityTimeline.reset();
  for (const event of events) {
    store.activityTimeline.append(activityEventToTimelineEntry(event, event.timestamp));
  }
}

function authRequest(
  url: string,
  wallet: string = ALICE,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    headers: {
      authorization: `Bearer ${signToken(wallet)}`,
      ...headers,
    },
  });
}

function makeEvents(
  count: number,
  prefix: string,
  streamId: string,
  actorAddress?: string,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      id: `${prefix}-${String(i).padStart(2, "0")}`,
      type: "stream.created",
      streamId,
      actorAddress,
      timestamp: `2026-05-${String(30 - i).padStart(2, "0")}T12:00:00Z`,
      description: `${prefix} event ${i}`,
    });
  }
  return events;
}

describe("GET /api/activity", () => {
  beforeEach(() => {
    setStore(createInMemoryPersistenceStore(false));
    seedStreams();
    seedActivity();
    resetRateLimitStore();
  });

  describe("authentication", () => {
    it("returns 401 with the standard envelope when no token is supplied", async () => {
      const req = new Request("http://localhost/api/activity");
      const res = await GET(req);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toBe("Missing or invalid authorization header");
      expect(body.error.request_id).toBe("test-req-id");
      expect(body.data).toBeUndefined();
    });

    it("returns 401 for an invalid bearer token", async () => {
      const req = new Request("http://localhost/api/activity", {
        headers: { authorization: "Bearer not-a-valid-token" },
      });
      const res = await GET(req);

      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("caller scoping", () => {
    it("returns only caller A's stream events and A's own wallet events", async () => {
      seedActivity([
        ...defaultEvents,
        { id: "evt-bob-stream", type: "stream.created", streamId: "stream-bob", timestamp: "2026-04-29T09:00:00Z", description: "Bob stream." },
        { id: "evt-bob-wallet", type: "wallet.connected", actorAddress: BOB, timestamp: "2026-04-29T10:00:00Z", description: "Bob wallet." },
      ]);

      const res = await GET(authRequest("http://localhost/api/activity"));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(6);
      expect(body.meta.total).toBe(6);
      expect(body.data.map((event: ActivityEvent) => event.id)).toEqual([
        "evt-1",
        "evt-2",
        "evt-3",
        "evt-4",
        "evt-5",
        "evt-6",
      ]);
      expect(body.data.some((event: ActivityEvent) => event.id === "evt-bob-stream")).toBe(false);
      expect(body.data.some((event: ActivityEvent) => event.id === "evt-bob-wallet")).toBe(false);
    });

    it("returns 404 when caller A requests caller B's streamId", async () => {
      const res = await GET(
        authRequest("http://localhost/api/activity?streamId=stream-bob"),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("STREAM_NOT_FOUND");
      expect(body.data).toBeUndefined();
    });

    it("returns 404 for an unknown streamId instead of an empty page", async () => {
      const res = await GET(
        authRequest("http://localhost/api/activity?streamId=stream-does-not-exist"),
      );

      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
    });

    it("ignores a spoofed x-tenant-id header", async () => {
      const plain = await GET(authRequest("http://localhost/api/activity"));
      const plainBody = await plain.json();

      const spoofed = await GET(
        authRequest("http://localhost/api/activity", ALICE, {
          "x-tenant-id": "some-other-tenant",
        }),
      );
      const spoofedBody = await spoofed.json();

      expect(spoofed.status).toBe(200);
      expect(spoofedBody.meta).toEqual(plainBody.meta);
      expect(spoofedBody.data.map((event: ActivityEvent) => event.id)).toEqual(
        plainBody.data.map((event: ActivityEvent) => event.id),
      );
      expect(spoofedBody.data.every((event: ActivityEvent) => event.isDeleted === false)).toBe(true);
    });
  });

  describe("pagination", () => {
    it("returns default paginated response with limit 20", async () => {
      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.data).toHaveLength(6);
      expect(body.meta.hasNext).toBe(false);
      expect(body.meta.nextCursor).toBeNull();
      expect(body.meta.total).toBe(6);
    });

    it("respects custom limit parameter", async () => {
      const req = authRequest("http://localhost/api/activity?limit=2");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(2);
      expect(body.meta.hasNext).toBe(true);
      expect(body.meta.total).toBe(6);
    });

    it("returns hasNext false when results fit in single page", async () => {
      const req = authRequest("http://localhost/api/activity?limit=10");
      const res = await GET(req);
      const body = await res.json();

      expect(body.meta.hasNext).toBe(false);
      expect(body.meta.nextCursor).toBeNull();
    });

    it("computes total and hasNext on the scoped set, not the global set", async () => {
      seedActivity([
        ...makeEvents(5, "alice", "stream-ada"),
        ...makeEvents(25, "bob", "stream-bob"),
      ]);

      const res = await GET(authRequest("http://localhost/api/activity?limit=2"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.meta.total).toBe(5);
      expect(body.meta.hasNext).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data.every((event: ActivityEvent) => event.streamId === "stream-ada")).toBe(true);
    });

    it("paginates A's scoped feed across 3 pages without duplicates or gaps", async () => {
      seedActivity([
        ...makeEvents(5, "alice", "stream-ada"),
        ...makeEvents(10, "bob", "stream-bob"),
      ]);

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 3; page++) {
        const url = cursor
          ? `http://localhost/api/activity?limit=2&cursor=${encodeURIComponent(cursor)}`
          : "http://localhost/api/activity?limit=2";
        const res = await GET(authRequest(url));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.meta.total).toBe(5);
        seen.push(...body.data.map((event: ActivityEvent) => event.id));
        cursor = body.meta.nextCursor;
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      expect(seen).toEqual(["alice-00", "alice-01", "alice-02", "alice-03", "alice-04"]);
      expect(cursor).toBeNull();
    });
  });

  describe("query validation", () => {
    it.each(["abc", "0", "101", "-5", "1.5", ""])(
      "rejects malformed limit %p with 422 INVALID_LIMIT",
      async (limit) => {
        const res = await GET(
          authRequest(`http://localhost/api/activity?limit=${encodeURIComponent(limit)}`),
        );

        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error.code).toBe("INVALID_LIMIT");
        expect(body.error.request_id).toBe("test-req-id");
      },
    );

    it("accepts the boundary limits 1 and 100", async () => {
      const low = await GET(authRequest("http://localhost/api/activity?limit=1"));
      expect(low.status).toBe(200);
      expect((await low.json()).data).toHaveLength(1);

      const high = await GET(authRequest("http://localhost/api/activity?limit=100"));
      expect(high.status).toBe(200);
      expect((await high.json()).data).toHaveLength(6);
    });

    it("rejects an unknown event type with 422 INVALID_TYPE", async () => {
      const res = await GET(
        authRequest("http://localhost/api/activity?type=unknown.type"),
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_TYPE");
    });

    it("rejects a streamId outside the id charset with 422 INVALID_STREAM_ID", async () => {
      const res = await GET(
        authRequest("http://localhost/api/activity?streamId=stream%20ada!%2F.."),
      );

      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_STREAM_ID");
    });
  });

  describe("cursor-based navigation", () => {
    it("paginates forward through all scoped events", async () => {
      const allEvents: ActivityEvent[] = [];
      let cursor: string | null = null;

      for (let i = 0; i < 10; i++) {
        const url = cursor
          ? `http://localhost/api/activity?limit=2&cursor=${encodeURIComponent(cursor)}`
          : "http://localhost/api/activity?limit=2";
        const req = authRequest(url);
        const res = await GET(req);
        const body = await res.json();

        allEvents.push(...body.data);
        cursor = body.meta.nextCursor;

        if (!body.meta.hasNext) break;
      }

      expect(allEvents).toHaveLength(6);
      expect(allEvents[0].id).toBe("evt-1");
      expect(allEvents[5].id).toBe("evt-6");
    });

    it("encodes composite cursor with timestamp and id", async () => {
      const req = authRequest("http://localhost/api/activity?limit=2");
      const res = await GET(req);
      const body = await res.json();

      expect(body.meta.nextCursor).not.toBeNull();

      const decoded = decodeCompositeCursor(body.meta.nextCursor);
      expect(decoded.timestamp).toBe("2026-04-27T20:00:00Z");
      expect(decoded.id).toBe("evt-2");
    });

    it("returns null cursor when no more pages", async () => {
      const req = authRequest("http://localhost/api/activity?limit=10");
      const res = await GET(req);
      const body = await res.json();

      expect(body.meta.nextCursor).toBeNull();
    });

    it("rejects malformed cursor with 422", async () => {
      const req = authRequest("http://localhost/api/activity?cursor=not-base64!");
      const res = await GET(req);
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CURSOR");
    });

    it("tolerates cursor pointing at non-existent position", async () => {
      const fakeCursor = encodeCompositeCursor("2025-01-01T00:00:00Z", "nonexistent-id");
      const req = authRequest(
        `http://localhost/api/activity?cursor=${encodeURIComponent(fakeCursor)}`,
      );
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(0);
      expect(body.meta.hasNext).toBe(false);
    });
  });

  describe("stable ordering", () => {
    it("sorts by timestamp descending then id descending", async () => {
      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      const body = await res.json();

      for (let i = 1; i < body.data.length; i++) {
        const prev = body.data[i - 1];
        const curr = body.data[i];
        const tsCmp = prev.timestamp.localeCompare(curr.timestamp);
        expect(tsCmp >= 0).toBe(true);
        if (tsCmp === 0) {
          expect(prev.id.localeCompare(curr.id) >= 0).toBe(true);
        }
      }
    });

    it("orders events with same timestamp by id descending", async () => {
      const sameTsEvents: ActivityEvent[] = [
        { id: "b-first", type: "stream.created", streamId: "stream-ada", timestamp: "2026-04-01T12:00:00Z", description: "B" },
        { id: "a-second", type: "stream.created", streamId: "stream-ada", timestamp: "2026-04-01T12:00:00Z", description: "A" },
        { id: "c-third", type: "stream.created", streamId: "stream-ada", timestamp: "2026-04-01T11:00:00Z", description: "C" },
      ];
      seedActivity(sameTsEvents);

      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data[0].id).toBe("b-first");
      expect(body.data[1].id).toBe("a-second");
      expect(body.data[2].id).toBe("c-third");
    });
  });

  describe("filtering", () => {
    it("filters by streamId", async () => {
      const req = authRequest("http://localhost/api/activity?streamId=stream-ada");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(2);
      expect(body.meta.total).toBe(2);
      expect(body.data.every((e: ActivityEvent) => e.streamId === "stream-ada")).toBe(true);
    });

    it("filters by type", async () => {
      const req = authRequest("http://localhost/api/activity?type=stream.created");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(3);
      expect(body.meta.total).toBe(3);
      expect(body.data.every((e: ActivityEvent) => e.type === "stream.created")).toBe(true);
    });

    it("combines streamId and type filters", async () => {
      const req = authRequest(
        "http://localhost/api/activity?streamId=stream-yusuf&type=stream.created",
      );
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("evt-5");
    });
  });

  describe("deleted streams", () => {
    it("keeps caller A's deleted stream event visible with isDeleted true", async () => {
      seedActivity([
        {
          id: "evt-deleted",
          type: "stream.stopped",
          streamId: "stream-deleted",
          actorAddress: ALICE,
          timestamp: "2026-04-30T09:00:00Z",
          description: "Deleted stream stopped.",
        },
      ]);

      const res = await GET(authRequest("http://localhost/api/activity"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(1);
      expect(body.meta.total).toBe(1);
      expect(body.data[0].id).toBe("evt-deleted");
      expect(body.data[0].isDeleted).toBe(true);
    });

    it("does not expose a deleted stream to a caller who never owned it", async () => {
      seedActivity([
        {
          id: "evt-deleted",
          type: "stream.stopped",
          streamId: "stream-deleted",
          timestamp: "2026-04-30T09:00:00Z",
          description: "Deleted stream stopped.",
        },
      ]);

      const res = await GET(authRequest("http://localhost/api/activity"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });
  });

  describe("response structure", () => {
    it("includes data, meta, and links in response", async () => {
      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      const body = await res.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect(body).toHaveProperty("links");
      expect(body.meta).toHaveProperty("hasNext");
      expect(body.meta).toHaveProperty("nextCursor");
      expect(body.meta).toHaveProperty("total");
      expect(body.links).toHaveProperty("self");
    });

    it("links.self points to /api/activity", async () => {
      const req = authRequest("http://localhost/api/activity?limit=5");
      const res = await GET(req);
      const body = await res.json();

      expect(body.links.self).toBe("/api/activity?limit=5");
    });
  });

  describe("edge cases", () => {
    it("handles single event correctly", async () => {
      seedActivity([defaultEvents[0]]);
      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(1);
      expect(body.meta.hasNext).toBe(false);
    });

    it("handles empty database", async () => {
      seedActivity([]);
      const req = authRequest("http://localhost/api/activity");
      const res = await GET(req);
      const body = await res.json();

      expect(body.data).toHaveLength(0);
      expect(body.meta.hasNext).toBe(false);
      expect(body.meta.nextCursor).toBeNull();
      expect(body.meta.total).toBe(0);
    });

    it("handles multiple pages with limit boundary", async () => {
      const manyEvents: ActivityEvent[] = [];
      for (let i = 0; i < 5; i++) {
        const pad = String(i).padStart(2, "0");
        manyEvents.push({
          id: `evt-${pad}`,
          type: "stream.created",
          streamId: "stream-ada",
          timestamp: `2026-04-${30 - i}T12:00:00Z`,
          description: `Event ${i}`,
        });
      }
      seedActivity(manyEvents);

      const req = authRequest("http://localhost/api/activity?limit=3");
      const res = await GET(req);
      const body1 = await res.json();

      expect(body1.data).toHaveLength(3);
      expect(body1.meta.hasNext).toBe(true);
      expect(body1.meta.nextCursor).not.toBeNull();

      const req2 = authRequest(
        `http://localhost/api/activity?limit=3&cursor=${encodeURIComponent(body1.meta.nextCursor)}`,
      );
      const res2 = await GET(req2);
      const body2 = await res2.json();

      expect(body2.data).toHaveLength(2);
      expect(body2.meta.hasNext).toBe(false);
      expect(body2.meta.nextCursor).toBeNull();
    });
  });

  describe("rate limiting", () => {
    it("returns 429 when rate limited", async () => {
      const req = authRequest("http://localhost/api/activity", ALICE, {
        "x-forwarded-for": "rate-limit-test-client",
      });

      let limited = false;
      let retryAfter: string | null = null;

      for (let i = 0; i < 70; i++) {
        const res = await GET(req);
        if (res.status === 429) {
          limited = true;
          retryAfter = res.headers.get("retry-after");
          break;
        }
      }

      expect(limited).toBe(true);
      expect(retryAfter).not.toBeNull();
    });
  });
});
