/** @jest-environment node */

import jwt from "jsonwebtoken";
import { GET as listExports } from "@/app/api/exports/route";
import { db, resetDb } from "@/app/lib/db";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";

const JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

function makeToken(walletAddress: string): string {
  return jwt.sign(
    { sub: walletAddress, role: "user", iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function authRequest(url: string, token: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    headers: {
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
  });
}

describe("GET /api/exports ETag handling (Issue #1120)", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    db.exportJobs.set("job1", {
      id: "job1",
      ownerId: "GOWNER1",
      requestedAt: "2026-07-24T10:00:00Z",
      status: "pending",
      expiresAt: "2026-07-31T10:00:00Z",
      fileName: "export1.csv",
      rows: 0,
    });
  });

  it("returns 200 with a strong ETag and cache-control on the first request", async () => {
    const token = makeToken("GOWNER1");
    const res = await listExports(authRequest("http://localhost/api/exports", token));

    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it("returns 304 Not Modified when If-None-Match matches the current ETag", async () => {
    const token = makeToken("GOWNER1");
    const initialRes = await listExports(authRequest("http://localhost/api/exports", token));
    const etag = initialRes.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const cachedRes = await listExports(
      authRequest("http://localhost/api/exports", token, { "If-None-Match": etag })
    );

    expect(cachedRes.status).toBe(304);
    expect(cachedRes.headers.get("etag")).toBe(etag);
    expect(cachedRes.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    await expect(cachedRes.text()).resolves.toBe("");
  });

  it("returns 200 with a new ETag when the export list changes", async () => {
    const token = makeToken("GOWNER1");
    const firstRes = await listExports(authRequest("http://localhost/api/exports", token));
    const firstEtag = firstRes.headers.get("etag")!;

    db.exportJobs.set("job2", {
      id: "job2",
      ownerId: "GOWNER1",
      requestedAt: "2026-07-24T11:00:00Z",
      status: "pending",
      expiresAt: "2026-07-31T11:00:00Z",
      fileName: "export2.csv",
      rows: 0,
    });

    const secondRes = await listExports(
      authRequest("http://localhost/api/exports", token, { "If-None-Match": firstEtag })
    );

    expect(secondRes.status).toBe(200);
    const secondEtag = secondRes.headers.get("etag");
    expect(secondEtag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(secondEtag).not.toBe(firstEtag);
    const body = await secondRes.json();
    expect(body.data).toHaveLength(2);
  });
});
