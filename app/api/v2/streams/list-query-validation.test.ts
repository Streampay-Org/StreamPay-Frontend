/**
 * @jest-environment node
 *
 * GET /api/v2/streams query validation and keyset pagination.
 *
 * v2 used to parse `limit` with `parseInt` without a NaN check and decoded the
 * cursor with the lenient base64 helper, so `?limit=abc` returned an empty page
 * and a broken cursor silently restarted the listing at page one.
 */

import { getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { GET as listStreamsV2 } from "@/app/api/v2/streams/route";
import type { Stream } from "@/app/types/openapi";

const AUTH_HEADERS = { authorization: "Bearer test-token" };
const VALID_STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function getRequest(query = "", headers: Record<string, string> = AUTH_HEADERS) {
  return new Request(`http://localhost/api/v2/streams${query}`, { headers });
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

describe("GET /api/v2/streams query validation", () => {
  it("requires a bearer token", async () => {
    const res = await listStreamsV2(getRequest("", {}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 422 INVALID_LIMIT for a non-numeric limit", async () => {
    const res = await listStreamsV2(getRequest("?limit=abc"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LIMIT");
  });

  it("returns 422 INVALID_LIMIT for a limit outside the allowed range", async () => {
    for (const value of ["0", "101"]) {
      const res = await listStreamsV2(getRequest(`?limit=${value}`));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_LIMIT");
    }
  });

  it("returns 422 INVALID_STATUS for an unknown status", async () => {
    const res = await listStreamsV2(getRequest("?status=bogus"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATUS");
  });

  it("returns 422 INVALID_CURSOR for a cursor that is not base64", async () => {
    const res = await listStreamsV2(getRequest("?cursor=not-base64"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 422 for a cursor that does not resolve to a stream", async () => {
    const cursor = Buffer.from("no-such-id").toString("base64");
    const res = await listStreamsV2(getRequest(`?cursor=${encodeURIComponent(cursor)}`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("filters by status", async () => {
    clearStreams();
    seedStreamAt("stream-draft", "2026-01-01T00:00:00.000Z");
    const res = await listStreamsV2(getRequest("?status=draft"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streams.map((stream: { id: string }) => stream.id)).toEqual(["stream-draft"]);
  });

  it("walks every page exactly once", async () => {
    clearStreams();
    for (let index = 0; index < 5; index += 1) {
      seedStreamAt(`stream-page-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const res = await listStreamsV2(getRequest(query));
      expect(res.status).toBe(200);
      const body = await res.json();
      pages += 1;
      for (const stream of body.streams) {
        seen.push(stream.id);
      }
      cursor = body.meta.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
    expect(cursor).toBeNull();
  });
});