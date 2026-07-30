/** @jest-environment node */

import { GET as listStreams } from "@/app/api/streams/route";
import { resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

describe("GET /api/streams ETag handling", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
  });

  it("returns 200 with an ETag and cache-control headers on the first request", async () => {
    const req = new Request("http://localhost/api/streams", { method: "GET" });

    const res = await listStreams(req);
    expect(res.status).toBe(200);

    const etag = res.headers.get("etag");
    expect(etag).toBeDefined();
    expect(etag).toMatch(/^"[^"]+"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 304 Not Modified when If-None-Match matches the current ETag", async () => {
    const initialReq = new Request("http://localhost/api/streams", { method: "GET" });
    const initialRes = await listStreams(initialReq);
    const etag = initialRes.headers.get("etag");

    expect(etag).toBeDefined();

    const cachedReq = new Request("http://localhost/api/streams", {
      method: "GET",
      headers: { "If-None-Match": etag! },
    });

    const cachedRes = await listStreams(cachedReq);
    expect(cachedRes.status).toBe(304);
    expect(cachedRes.headers.get("etag")).toBe(etag);
    expect(cachedRes.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    await expect(cachedRes.text()).resolves.toBe("");
  });
});
