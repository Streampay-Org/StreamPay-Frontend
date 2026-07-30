/**
 * @jest-environment node
 *
 * GET /api/streams query validation — limit, status, and cursor are
 * validated at the boundary and rejected with 422 VALIDATION_ERROR plus
 * per-field details instead of silently degrading (a malformed limit
 * previously produced an empty list).
 */

import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { GET as listStreams, POST as createStream } from "@/app/api/streams/route";

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

  it("treats a decodable but unknown cursor as a no-op", async () => {
    const res = await listStreams(getRequest("?cursor=bm8tc3VjaC1pZA=="));
    expect(res.status).toBe(200);
  });

  it("ignores unknown query params", async () => {
    await seedStreams(1);
    const res = await listStreams(getRequest("?foo=bar"));
    expect(res.status).toBe(200);
  });
});
