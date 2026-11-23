import { GET } from "./route";
import { getStore } from "@/app/lib/db";
import type { Stream } from "@/app/types/openapi";

function makeStream(overrides: Partial<Stream> & { id: string }): Stream {
  const now = new Date().toISOString();
  return {
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    rate: "100",
    schedule: "daily",
    status: "active",
    token: "XLM",
    totalAmount: "10000000",
    releasedAmount: "2500000",
    createdAt: now,
    updatedAt: now,
    ownership: "unclaimed",
    ...overrides,
  };
}

describe("GET /api/streams/stats", () => {
  beforeEach(() => {
    getStore().streamRepository.reset();
  });

  it("returns zero counts and empty totals when no streams exist", async () => {
    const req = new Request("http://localhost/api/streams/stats");
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();

    const body = await res.json();
    expect(body).toEqual({
      data: {
        counts: {
          draft: 0,
          active: 0,
          paused: 0,
          ended: 0,
          withdrawn: 0,
          cancelled: 0,
        },
        totals: {},
        skipped: 0,
      },
      links: { self: "/api/streams/stats" },
    });
  });

  it("aggregates visible streams by status and token with exact BigInt totals", async () => {
    const { streamRepository } = getStore();
    streamRepository.streams.set(
      "s-1",
      makeStream({
        id: "s-1",
        status: "active",
        token: "XLM",
        totalAmount: "9007199254740993000",
        releasedAmount: "1000000000000000001",
      }),
    );
    streamRepository.streams.set(
      "s-2",
      makeStream({
        id: "s-2",
        status: "paused",
        token: "USDC",
        totalAmount: "50000000",
        releasedAmount: "10000000",
      }),
    );
    streamRepository.streams.set(
      "s-3",
      makeStream({
        id: "s-3",
        status: "ended",
        token: "XLM",
        totalAmount: "bad-value",
        releasedAmount: "0",
      }),
    );

    const req = new Request("http://localhost/api/streams/stats");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toEqual({
      counts: {
        draft: 0,
        active: 1,
        paused: 1,
        ended: 1,
        withdrawn: 0,
        cancelled: 0,
      },
      totals: {
        XLM: {
          escrowed: "9007199254740993000",
          released: "1000000000000000001",
        },
        USDC: {
          escrowed: "50000000",
          released: "10000000",
        },
      },
      skipped: 1,
    });
  });

  it("scopes stats strictly by tenant and excludes other tenants", async () => {
    const { streamRepository } = getStore();
    streamRepository.streams.set(
      "t1-stream",
      makeStream({
        id: "t1-stream",
        tenant: "tenant-alpha",
        status: "active",
        token: "XLM",
        totalAmount: "1000",
        releasedAmount: "100",
      }),
    );
    streamRepository.streams.set(
      "t2-stream",
      makeStream({
        id: "t2-stream",
        tenant: "tenant-beta",
        status: "active",
        token: "XLM",
        totalAmount: "999999",
        releasedAmount: "500000",
      }),
    );

    const req = new Request("http://localhost/api/streams/stats", {
      headers: { "x-tenant-id": "tenant-alpha" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data.counts.active).toBe(1);
    expect(body.data.totals.XLM).toEqual({ escrowed: "1000", released: "100" });
  });

  it("supports ETag 304 Not Modified revalidation", async () => {
    const { streamRepository } = getStore();
    streamRepository.streams.set("s-etag", makeStream({ id: "s-etag" }));

    const firstRes = await GET(new Request("http://localhost/api/streams/stats"));
    expect(firstRes.status).toBe(200);
    const etag = firstRes.headers.get("etag");
    expect(etag).toBeTruthy();

    const secondRes = await GET(
      new Request("http://localhost/api/streams/stats", {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(secondRes.status).toBe(304);
    expect(secondRes.headers.get("etag")).toBe(etag);
  });
});
