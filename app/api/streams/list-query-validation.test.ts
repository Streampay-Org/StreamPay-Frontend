/**
 * @jest-environment node
 *
 * GET /api/streams query validation — limit, status, and cursor are
 * validated at the boundary and rejected with 422 VALIDATION_ERROR plus
 * per-field details instead of silently degrading (a malformed limit
 * previously produced an empty list).
 */

import * as fc from "fast-check";
import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { GET as listStreams, POST as createStream } from "@/app/api/streams/route";
import type { Stream } from "@/app/types/openapi";

const VALID_STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function getRequest(query: string = "") {
  return new Request(`http://localhost/api/streams${query}`);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seedStreams(count: number) {
  for (let i = 0; i < count; i++) {
    const res = await createStream(
      postRequest({ recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" }),
    );
    expect(res.status).toBe(201);
  }
}

/** Adds one stream at a known position in the `(createdAt, id)` ordering. */
function seedStreamAt(id: string, createdAt: string) {
  const stream: Stream = {
    createdAt,
    id,
    nextAction: "start",
    rate: "50",
    recipient: VALID_STELLAR_KEY,
    schedule: "month",
    status: "draft",
    token: "XLM",
    updatedAt: createdAt,
  };
  getStore().streamRepository.streams.set(id, stream);
}

/** Empties the stream store so a pagination walk only sees the seeded rows. */
function clearStreams() {
  getStore().streamRepository.streams.clear();
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
});

describe("GET /api/streams query validation", () => {
  it("returns 200 with defaults when no query params are given", async () => {
    const res = await listStreams(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("applies a valid limit", async () => {
    await seedStreams(3);
    const res = await listStreams(getRequest("?limit=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.hasNext).toBe(true);
  });

  it("returns 422 with a limit detail for a non-numeric limit", async () => {
    const res = await listStreams(getRequest("?limit=abc"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      expect.objectContaining({ field: "limit" }),
    ]);
  });

  it("returns 422 when limit is out of range", async () => {
    for (const value of ["0", "101"]) {
      const res = await listStreams(getRequest(`?limit=${value}`));
      expect(res.status).toBe(422);
    }
  });

  it("filters by a valid status", async () => {
    await seedStreams(2);
    const res = await listStreams(getRequest("?status=draft"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    for (const stream of body.data) {
      expect(stream.status).toBe("draft");
    }
  });

  it("returns 422 with a status detail for an unknown status", async () => {
    const res = await listStreams(getRequest("?status=bogus"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details).toEqual([
      expect.objectContaining({ field: "status" }),
    ]);
  });

  it("returns 422 for an empty cursor param", async () => {
    const res = await listStreams(getRequest("?cursor="));
    expect(res.status).toBe(422);
  });

  it("returns 422 for a cursor that does not resolve to a stream", async () => {
    const res = await listStreams(getRequest("?cursor=bm8tc3VjaC1pZA=="));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("ignores unknown query params", async () => {
    await seedStreams(1);
    const res = await listStreams(getRequest("?foo=bar"));
    expect(res.status).toBe(200);
  });

  it("returns 422 for a cursor that is not base64", async () => {
    const res = await listStreams(getRequest("?cursor=not-base64"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 422 for base64 that is not a cursor", async () => {
    const cursor = Buffer.from("garbage").toString("base64");
    const res = await listStreams(getRequest(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("accepts a legacy plain-id cursor while the stream still exists", async () => {
    clearStreams();
    seedStreamAt("stream-legacy", "2026-01-01T00:00:00.000Z");
    seedStreamAt("stream-after", "2026-01-02T00:00:00.000Z");

    const cursor = Buffer.from("stream-legacy").toString("base64");
    const res = await listStreams(getRequest(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((stream: { id: string }) => stream.id)).toEqual(["stream-after"]);
  });

  it("walks every page exactly once", async () => {
    clearStreams();
    for (let index = 0; index < 7; index += 1) {
      seedStreamAt(`stream-page-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const res = await listStreams(getRequest(query));
      expect(res.status).toBe(200);
      const body = await res.json();
      pages += 1;
      for (const stream of body.data) {
        seen.push(stream.id);
      }
      cursor = body.meta.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
    expect(cursor).toBeNull();
  });

  it("resumes after the cursor row instead of restarting at page one", async () => {
    clearStreams();
    for (let index = 0; index < 5; index += 1) {
      seedStreamAt(`stream-page-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`);
    }

    const first = await listStreams(getRequest("?limit=2"));
    const firstBody = await first.json();
    expect(firstBody.data.map((stream: { id: string }) => stream.id)).toEqual([
      "stream-page-0",
      "stream-page-1",
    ]);

    // The row the cursor points at disappears between the two requests.
    getStore().streamRepository.streams.delete("stream-page-1");

    const second = await listStreams(
      getRequest(`?limit=2&cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.map((stream: { id: string }) => stream.id)).toEqual([
      "stream-page-2",
      "stream-page-3",
    ]);
  });

  it("never repeats a stream while walking the pages (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        async (gaps, limit) => {
          // Every case starts from an empty store and a fresh rate-limit
          // bucket, so the walk only sees the seeded rows and is never
          // throttled by the requests the previous cases made.
          resetRateLimitStore();
          clearStreams();

          const expected: string[] = [];
          let minute = 0;
          gaps.forEach((gap, index) => {
            minute += gap;
            const id = `stream-prop-${String(index).padStart(2, "0")}`;
            expected.push(id);
            seedStreamAt(id, `2026-02-01T00:${String(minute).padStart(2, "0")}:00.000Z`);
          });

          const seen: string[] = [];
          let cursor: string | null = null;
          let guard = 0;

          do {
            guard += 1;
            expect(guard).toBeLessThanOrEqual(40);
            const query = cursor
              ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
              : `?limit=${limit}`;
            const res = await listStreams(getRequest(query));
            expect(res.status).toBe(200);
            const body = await res.json();
            for (const stream of body.data) {
              seen.push(stream.id);
            }
            cursor = body.meta.nextCursor;
          } while (cursor);

          // Every stream is seen exactly once, in list order.
          expect(seen).toEqual(expected);

          // fast-check requires an explicit `true` from the predicate.
          return true;
        },
      ),
      { numRuns: 20, seed: 42 },
    );
  });
});