/** @jest-environment node */

import { GET } from "./route";
import { resetDb, getStore } from "@/app/lib/db";
import { signToken } from "@/app/lib/auth";
import type { Stream } from "@/app/types/openapi";

const ALICE = "GALICE0000000000000000000000000000000000000000000000000000";

function authRequest(query = "", extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost/api/v2/streams${query}`, {
    headers: {
      authorization: `Bearer ${signToken(ALICE)}`,
      ...extraHeaders,
    },
  });
}

function seedStreams(count: number, status: Stream["status"] = "active") {
  const store = getStore();
  for (let i = 0; i < count; i++) {
    const id = `stream-v2-${String(i).padStart(2, "0")}`;
    const ts = `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`;
    const stream: Stream = {
      id,
      recipient: ALICE,
      rate: "100",
      schedule: "month",
      status,
      createdAt: ts,
      updatedAt: ts,
      token: "XLM",
    };
    store.streamRepository.streams.set(id, stream);
  }
}

describe("GET /api/v2/streams RFC 8288 Link headers", () => {
  beforeEach(() => {
    resetDb();
    getStore().streamRepository.streams.clear();
  });

  it("emits rel=\"next\" on the first page and following it yields the next page without rel=\"next\" on the last page", async () => {
    seedStreams(3);

    const res1 = await GET(authRequest("?limit=2"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.streams).toHaveLength(2);
    expect(body1.meta.hasNext).toBe(true);
    expect(body1.links.self).toBe("/api/v2/streams?limit=2");

    const link1 = res1.headers.get("Link");
    expect(link1).toBeTruthy();
    const nextMatch = link1!.match(/<([^>]+)>;\s*rel="next"/);
    expect(nextMatch).not.toBeNull();
    expect(nextMatch![1]).toBe(
      `/api/v2/streams?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor)}`,
    );

    const nextQuery = nextMatch![1].slice("/api/v2/streams".length);
    const res2 = await GET(authRequest(nextQuery));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.streams).toHaveLength(1);
    expect(body2.meta.hasNext).toBe(false);
    expect(body2.links.self).toBe(nextMatch![1]);

    const link2 = res2.headers.get("Link");
    expect(link2).toBeTruthy();
    expect(link2).not.toContain('rel="next"');
    expect(link2).toContain('rel="self"');
  });

  it("preserves status filter in Link and links.self", async () => {
    seedStreams(3, "paused");

    const res = await GET(authRequest("?limit=2&status=paused"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.links.self).toBe("/api/v2/streams?limit=2&status=paused");

    const link = res.headers.get("Link")!;
    expect(link).toContain("status=paused");
    expect(link).toContain('rel="next"');
  });

  it("handles empty result and limit at max (100) without rel=\"next\"", async () => {
    const res = await GET(authRequest("?limit=100"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streams).toEqual([]);
    const link = res.headers.get("Link")!;
    expect(link).not.toContain('rel="next"');
    expect(link).toBe('</api/v2/streams?limit=100>; rel="self"');
  });

  it("preserves Link header on 304 Not Modified responses", async () => {
    seedStreams(3);

    const res1 = await GET(authRequest("?limit=2"));
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("ETag")!;
    const link1 = res1.headers.get("Link")!;

    const res304 = await GET(authRequest("?limit=2", { "if-none-match": etag }));
    expect(res304.status).toBe(304);
    expect(res304.headers.get("Link")).toBe(link1);
  });
});
