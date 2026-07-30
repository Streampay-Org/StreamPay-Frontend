/**
 * Prometheus metrics coverage for GET|POST /api/exports.
 */

import jwt from "jsonwebtoken";
import { db, resetDb } from "@/app/lib/db";
import {
  getRateLimitStore,
  InMemoryRateLimitStore,
  resetRateLimitStore,
} from "@/app/lib/rate-limit-store";
import { registry } from "@/src/metrics/registry";
import { GET, POST } from "./route";

const JWT_SECRET = "streampay-dev-secret-do-not-use-in-prod";

function makeToken(walletAddress: string, role = "user"): string {
  return jwt.sign(
    { sub: walletAddress, role, iss: "streampay", aud: "streampay-api" },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function postRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/exports", { method: "POST", headers });
}

function getRequest(token?: string, search = ""): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/exports${search}`, { method: "GET", headers });
}

describe("Exports API — Prometheus metrics", () => {
  beforeEach(() => {
    resetDb();
    resetRateLimitStore();
    registry.resetMetrics();
  });

  afterEach(() => {
    const store = getRateLimitStore();
    if (store instanceof InMemoryRateLimitStore) {
      store.destroy();
    }
    resetRateLimitStore();
  });

  it("records counter + histogram on successful POST (201)", async () => {
    const res = await POST(postRequest(makeToken("GOWNER1")));
    expect(res.status).toBe(201);

    const metrics = await registry.metrics();
    expect(metrics).toContain('export_requests_total{status="201",method="POST"} 1');
    expect(metrics).toContain(
      'export_request_duration_seconds_count{status="201",method="POST"} 1',
    );
  });

  it("records metrics on unauthorized POST (401)", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(401);

    const metrics = await registry.metrics();
    expect(metrics).toContain('export_requests_total{status="401",method="POST"} 1');
    expect(metrics).toContain(
      'export_request_duration_seconds_count{status="401",method="POST"} 1',
    );
  });

  it("records metrics on successful GET list (200)", async () => {
    const token = makeToken("GOWNER1");
    db.exportJobs.set("job1", {
      id: "job1",
      ownerId: "GOWNER1",
      requestedAt: "2026-07-24T10:00:00Z",
      status: "pending",
      expiresAt: "2026-07-31T10:00:00Z",
      fileName: "export1.csv",
      rows: 0,
    });

    const res = await GET(getRequest(token));
    expect(res.status).toBe(200);

    const metrics = await registry.metrics();
    expect(metrics).toContain('export_requests_total{status="200",method="GET"} 1');
    expect(metrics).toContain(
      'export_request_duration_seconds_count{status="200",method="GET"} 1',
    );
  });

  it("records metrics on invalid limit (422)", async () => {
    const res = await GET(getRequest(makeToken("GOWNER1"), "?limit=0"));
    expect(res.status).toBe(422);

    const metrics = await registry.metrics();
    expect(metrics).toContain('export_requests_total{status="422",method="GET"} 1');
  });

  it("exposes HELP/TYPE lines for export metrics in the registry scrape", async () => {
    await POST(postRequest(makeToken("GOWNER1")));
    const metrics = await registry.metrics();

    expect(metrics).toContain("# HELP export_requests_total");
    expect(metrics).toContain("# TYPE export_requests_total counter");
    expect(metrics).toContain("# HELP export_request_duration_seconds");
    expect(metrics).toContain("# TYPE export_request_duration_seconds histogram");
  });
});
