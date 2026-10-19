/** @jest-environment node */
import { GET, DELETE } from "./route";
import { POST as createV1Stream } from "@/app/api/streams/route";
import { POST as createV2Stream } from "@/app/api/v2/streams/route";
import { POST as createMultiStream } from "@/app/api/v2/streams/multi/route";
import { POST as createBatchStreams } from "@/app/api/streams/batch/route";
import { POST as importStreams } from "@/app/api/streams/import/route";
import { db, getStore, resetDb } from "@/app/lib/db";
import { streamCache } from "@/app/lib/cache";
import { DEFAULT_TENANT } from "@/app/lib/tenant";
import { resetRateLimitStore } from "@/app/lib/rate-limit-store";
import { resetOrgQuotaStore } from "@/app/lib/org-quota-store";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";

const VALID_STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

type Context = { params: Promise<{ id: string }> };

function ctx(id: string): Context {
  return { params: Promise.resolve({ id }) };
}

function createRequest(body: unknown, tenant?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tenant !== undefined) {
    headers["x-tenant-id"] = tenant;
  }
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function readRequest(id: string, tenant?: string): Request {
  const headers: Record<string, string> = {};
  if (tenant !== undefined) {
    headers["x-tenant-id"] = tenant;
  }
  return new Request(`http://localhost/api/streams/${id}`, { headers });
}

function resetEmptyStreamStore(): void {
  resetDb();
  getStore().streamRepository.streams.clear();
}

async function createV1(tenant?: string): Promise<string> {
  const res = await createV1Stream(
    createRequest(
      { recipient: VALID_STELLAR_KEY, rate: "50", schedule: "month" },
      tenant,
    ),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

beforeEach(() => {
  resetDb();
  resetRateLimitStore();
  resetOrgQuotaStore();
  _resetAllowlistForTesting();
  addAllowedToken("XLM");
  process.env.STREAMPAY_CACHE_DISABLED = "true";
});

describe("stream tenant ownership", () => {
  it("returns tenantId on a stream created and read with the same tenant", async () => {
    const id = await createV1("acme");

    const res = await GET(readRequest(id, "acme"), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tenantId).toBe("acme");
  });

  it("hides a stream from another tenant", async () => {
    const id = await createV1("acme");

    const res = await GET(readRequest(id, "other"), ctx(id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("STREAM_NOT_FOUND");
  });

  it("uses the default tenant when no tenant is supplied", async () => {
    const id = await createV1();

    expect(db.streams.get(id)?.tenantId).toBe(DEFAULT_TENANT);

    const res = await GET(readRequest(id), ctx(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tenantId).toBe(DEFAULT_TENANT);
  });

  it("trims tenant headers so whitespace variants share one cache entry", async () => {
    process.env.STREAMPAY_CACHE_DISABLED = "false";
    const id = await createV1("  acme  ");
    const setSpy = jest.spyOn(streamCache, "set");

    try {
      const first = await GET(readRequest(id, "  acme  "), ctx(id));
      expect(first.status).toBe(200);
      expect(first.headers.get("X-Cache")).toBe("MISS");
      expect(setSpy).toHaveBeenCalledWith("acme", id, expect.anything(), expect.anything());

      const second = await GET(readRequest(id, "acme"), ctx(id));
      expect(second.status).toBe(200);
      expect(second.headers.get("X-Cache")).toBe("HIT");
      expect((await second.json()).data.id).toBe(id);
    } finally {
      setSpy.mockRestore();
    }
  });

  it("stamps every creation path with a non-empty tenantId", async () => {
    const tenant = "tenant-route-5";

    // v2 single stream
    const v2Res = await createV2Stream(
      new Request("http://localhost/api/v2/streams", {
        method: "POST",
        headers: {
          "Authorization": "Bearer test-token",
          "Content-Type": "application/json",
          "x-tenant-id": tenant,
        },
        body: JSON.stringify({ recipient: "GABC123", rate: "100 XLM / month", schedule: "month" }),
      }),
    );
    expect(v2Res.status).toBe(201);
    const v2Body = await v2Res.json();
    expect(getStore().streamRepository.streams.get(v2Body.id)?.tenantId).toBe(tenant);

    // multi-recipient fan-out
    resetEmptyStreamStore();
    resetRateLimitStore();
    resetOrgQuotaStore();
    const multiRes = await createMultiStream(
      new Request("http://localhost/api/v2/streams/multi", {
        method: "POST",
        headers: {
          "Authorization": "Bearer test-token",
          "Content-Type": "application/json",
          "x-tenant-id": tenant,
        },
        body: JSON.stringify({
          name: "Tenant test distribution",
          token: "XLM",
          totalAmount: 1000,
          startTime: "2026-09-01T09:00:00.000Z",
          endTime: "2026-12-31T23:59:00.000Z",
          recipients: [
            { address: VALID_STELLAR_KEY, percentage: 50 },
            { address: "ada@example.com", percentage: 50 },
          ],
        }),
      }),
    );
    expect(multiRes.status).toBe(201);
    const legs = Array.from(getStore().streamRepository.streams.values());
    expect(legs).toHaveLength(2);
    expect(legs.every((s) => s.tenantId === tenant)).toBe(true);

    // batch
    resetEmptyStreamStore();
    resetRateLimitStore();
    resetOrgQuotaStore();
    const batchRes = await createBatchStreams(
      new Request("http://localhost/api/streams/batch", {
        method: "POST",
        headers: {
          "Authorization": "Bearer test-token",
          "Content-Type": "application/json",
          "x-tenant-id": tenant,
        },
        body: JSON.stringify([
          { recipient: VALID_STELLAR_KEY, rate: "100", schedule: "month" },
        ]),
      }) as any,
    );
    expect(batchRes.status).toBe(201);
    const batchRows = Array.from(getStore().streamRepository.streams.values());
    expect(batchRows).toHaveLength(1);
    expect(batchRows[0].tenantId).toBe(tenant);

    // CSV import
    resetEmptyStreamStore();
    resetRateLimitStore();
    resetOrgQuotaStore();
    const importRes = await importStreams(
      new Request("http://localhost/api/streams/import", {
        method: "POST",
        headers: { "Content-Type": "text/csv", "x-tenant-id": tenant },
        body: `recipient,rate,schedule,token\n${VALID_STELLAR_KEY},100,month,XLM`,
      }),
    );
    expect(importRes.status).toBe(207);
    const importedRows = Array.from(getStore().streamRepository.streams.values());
    expect(importedRows).toHaveLength(1);
    expect(importedRows[0].tenantId).toBe(tenant);
  });

  it("reads a seeded demo stream with the default tenant", async () => {
    const res = await GET(readRequest("stream-ada"), ctx("stream-ada"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe("stream-ada");
  });

  it("keeps reading legacy rows that only carry the old tenant field", async () => {
    const stream = db.streams.get("stream-ada")!;
    const legacy = { ...stream, tenant: "legacy-tenant" } as any;
    delete legacy.tenantId;
    db.streams.set("stream-ada", legacy);

    const res = await GET(readRequest("stream-ada", "legacy-tenant"), ctx("stream-ada"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe("stream-ada");
  });

  it("does not delete a stream from the wrong tenant", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/streams/stream-ada", {
        method: "DELETE",
        headers: { "x-tenant-id": "not-the-owner" },
      }),
      ctx("stream-ada"),
    );

    expect(res.status).toBe(404);
    expect(db.streams.get("stream-ada")).toBeDefined();
  });

  it("produces different ETags for the same stream under two tenants", async () => {
    const stream = db.streams.get("stream-ada")!;

    db.streams.set("stream-ada", { ...stream, tenantId: "tenant-a" });
    const tagA = (
      await GET(readRequest("stream-ada", "tenant-a"), ctx("stream-ada"))
    ).headers.get("ETag");

    db.streams.set("stream-ada", { ...stream, tenantId: "tenant-b" });
    const tagB = (
      await GET(readRequest("stream-ada", "tenant-b"), ctx("stream-ada"))
    ).headers.get("ETag");

    expect(tagA).toMatch(/^"[0-9a-f]{64}"$/);
    expect(tagB).toMatch(/^"[0-9a-f]{64}"$/);
    expect(tagA).not.toBe(tagB);
  });
});
