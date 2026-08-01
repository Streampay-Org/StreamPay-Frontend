/** @jest-environment node */

import { GET } from "@/app/api/webhooks/route";
import { registry } from "@/src/metrics/registry";
import { createStrongEtagFromBody } from "@/src/middleware/etag";
import {
  setRateLimitStore,
  resetRateLimitStore,
  type RateLimitStore,
  type RateLimitResult,
} from "@/app/lib/rate-limit-store";

jest.mock("@/app/lib/logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  getCorrelationContext: jest.fn(() => ({ request_id: "test-req-id" })),
}));

function makeAllowAllStore(): RateLimitStore {
  return {
    async check(
      _identifier: string,
      _limit: number,
      _windowMs: number,
    ): Promise<RateLimitResult> {
      return {
        allowed: true,
        remaining: 999,
        resetAt: Math.floor(Date.now() / 1000) + 60,
      };
    },
  };
}

function makeGetRequest(extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks", {
    method: "GET",
    headers: new Headers(extraHeaders),
  });
}

describe("GET /api/webhooks ETag handling (Issue #1110)", () => {
  const stableMetrics =
    '# HELP webhook_requests_total Total webhook requests\n' +
    '# TYPE webhook_requests_total counter\n' +
    'webhook_requests_total{status="200",event_type="demo"} 1\n';

  let metricsSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    setRateLimitStore(makeAllowAllStore());
    // Default Node collectors (CPU/memory) change between scrapes; pin the
    // exposition body so ETag assertions are deterministic.
    metricsSpy = jest.spyOn(registry, "metrics").mockResolvedValue(stableMetrics);
  });

  afterEach(() => {
    metricsSpy.mockRestore();
    resetRateLimitStore();
  });

  it("returns 200 with a strong ETag and cache-control on the first scrape", async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    const etag = res.headers.get("etag");
    expect(etag).toBe(createStrongEtagFromBody(stableMetrics));
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(res.headers.get("Content-Type")).toContain("text/plain");

    await expect(res.text()).resolves.toBe(stableMetrics);
  });

  it("returns 304 Not Modified when If-None-Match matches the current ETag", async () => {
    const initialRes = await GET(makeGetRequest());
    const etag = initialRes.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const cachedRes = await GET(makeGetRequest({ "If-None-Match": etag }));

    expect(cachedRes.status).toBe(304);
    expect(cachedRes.headers.get("etag")).toBe(etag);
    expect(cachedRes.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    await expect(cachedRes.text()).resolves.toBe("");
  });

  it("returns 200 with a new ETag when metrics contents change", async () => {
    const firstRes = await GET(makeGetRequest());
    const firstEtag = firstRes.headers.get("etag")!;

    const updatedMetrics = stableMetrics + 'webhook_requests_total{status="500",event_type="demo"} 2\n';
    metricsSpy.mockResolvedValue(updatedMetrics);

    const secondRes = await GET(makeGetRequest({ "If-None-Match": firstEtag }));

    expect(secondRes.status).toBe(200);
    const secondEtag = secondRes.headers.get("etag");
    expect(secondEtag).toBe(createStrongEtagFromBody(updatedMetrics));
    expect(secondEtag).not.toBe(firstEtag);
    expect(secondRes.headers.get("Content-Type")).toContain("text/plain");
    await expect(secondRes.text()).resolves.toBe(updatedMetrics);
  });

  it("returns 304 for wildcard If-None-Match when a representation exists", async () => {
    const res = await GET(makeGetRequest({ "If-None-Match": "*" }));

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(createStrongEtagFromBody(stableMetrics));
    await expect(res.text()).resolves.toBe("");
  });

  it("returns 304 when If-None-Match list contains the matching ETag", async () => {
    const etag = createStrongEtagFromBody(stableMetrics);
    const res = await GET(
      makeGetRequest({ "If-None-Match": `"other-tag", ${etag}` }),
    );

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
  });
});
