/** @jest-environment node */
import { GET } from "./route";
import { _resetAdminStateForTesting } from "@/app/lib/admin-guard";
import { resetDb } from "@/app/lib/db";

const ADMIN_ADDRESS = "GADMIN_OPS_DASHBOARD_TEST_56789";

function makeRequest(
  streamId: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    `http://localhost/api/reconciliation/diff/${streamId}`,
    { method: "GET", headers },
  );
}

function adminRequest(streamId: string): Request {
  return makeRequest(streamId, { "Actor-Wallet-Address": ADMIN_ADDRESS });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/reconciliation/diff/:id (admin proxy)", () => {
  beforeEach(() => {
    _resetAdminStateForTesting(ADMIN_ADDRESS);
    resetDb();
  });

  it("returns 401 when no caller identity is supplied", async () => {
    const response = await GET(makeRequest("stream_1"), ctx("stream_1"));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the caller is not the admin", async () => {
    const response = await GET(
      makeRequest("stream_1", { "Actor-Wallet-Address": "GNOT_THE_ADMIN" }),
      ctx("stream_1"),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.code).toBe("Unauthorized");
  });

  it("returns 400 for an empty stream id", async () => {
    const response = await GET(adminRequest(""), ctx(""));
    expect(response.status).toBe(400);
  });

  it("returns 404 STREAM_NOT_FOUND for an unknown stream", async () => {
    const response = await GET(adminRequest("does-not-exist"), ctx("does-not-exist"));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("STREAM_NOT_FOUND");
  });

  it("returns an in-sync diff for a matching stream", async () => {
    const response = await GET(adminRequest("stream_1"), ctx("stream_1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.streamId).toBe("stream_1");
    expect(body.data.inSync).toBe(true);
    expect(body.data.diffs).toHaveLength(0);
    expect(body.data.db.id).toBe("stream_1");
    expect(body.data.onChain.id).toBe("stream_1");
  });

  it("returns a mismatch diff for stream_2 and never exposes internal auth", async () => {
    const response = await GET(adminRequest("stream_2"), ctx("stream_2"));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data.inSync).toBe(false);
    expect(body.data.diffs).toEqual([
      {
        field: "released_amount",
        dbValue: "1000000000",
        onChainValue: "1100000000",
        toleranceApplied: false,
      },
    ]);

    // The proxy must not leak internal HMAC metadata or signing secrets.
    expect(body.meta).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("keyId");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a DB-only stream with onChain:null when the chain has no record", async () => {
    const response = await GET(adminRequest("stream-ada"), ctx("stream-ada"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.db.id).toBe("stream-ada");
    expect(body.data.onChain).toBeNull();
  });

  it("includes an ISO checkedAt timestamp", async () => {
    const before = Date.now();
    const response = await GET(adminRequest("stream_1"), ctx("stream_1"));
    const after = Date.now();
    const body = await response.json();
    const checkedAt = Date.parse(body.data.checkedAt);
    expect(checkedAt).toBeGreaterThanOrEqual(before);
    expect(checkedAt).toBeLessThanOrEqual(after);
  });
});
