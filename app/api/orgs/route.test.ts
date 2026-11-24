/** @jest-environment node */

import { GET, POST } from "@/app/api/orgs/route";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
import { DEFAULT_STREAM_POLICY } from "@/app/lib/org-types";
import { resetDb, IDEMPOTENCY_TTL_MS } from "@/app/lib/db";
import { signToken } from "@/app/lib/auth";

const owner = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function request(body: unknown, key?: string, actor?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  if (actor) headers.Authorization = `Bearer ${signToken(actor)}`;
  return new Request("http://localhost/api/orgs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetDb();
  _resetOrgDbForTesting();
  jest.useRealTimers();
});

afterEach(() => jest.useRealTimers());

describe("POST /api/orgs idempotency", () => {
  it("replays the original response and creates one org", async () => {
    const body = { name: "Retry Org", ownerWalletAddress: owner };
    const first = await POST(request(body, "retry-1"));
    const replay = await POST(request(body, "retry-1"));
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(replay.headers.get("Idempotency-Replay")).toBe("true");
    expect([...orgDb.orgs.values()].filter((org) => org.name === "Retry Org")).toHaveLength(1);
  });

  it("does not replay across authenticated actors", async () => {
    const body = { name: "Actor Org", ownerWalletAddress: owner };
    expect((await POST(request(body, "actor-key", "actor-a"))).status).toBe(201);
    expect((await POST(request(body, "actor-key", "actor-b"))).status).toBe(409);
  });

  it("returns 409 when the same key has a different payload", async () => {
    expect((await POST(request({ name: "First", ownerWalletAddress: owner }, "body-key"))).status).toBe(201);
    expect((await POST(request({ name: "Second", ownerWalletAddress: owner }, "body-key"))).status).toBe(409);
  });

  it("creates again after the idempotency entry expires", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const body = { name: "Expired Org", ownerWalletAddress: owner };
    const first = await POST(request(body, "expiry-key"));
    jest.advanceTimersByTime(IDEMPOTENCY_TTL_MS + 1);
    const next = await POST(request(body, "expiry-key"));
    expect(first.status).toBe(201);
    expect(next.status).toBe(201);
    expect(await next.json()).not.toEqual(await first.json());
  });

  it("serializes concurrent duplicate submissions", async () => {
    const body = { name: "Concurrent Org", ownerWalletAddress: owner };
    const responses = await Promise.all([
      POST(request(body, "concurrent-key")),
      POST(request(body, "concurrent-key")),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect([...orgDb.orgs.values()].filter((org) => org.name === "Concurrent Org")).toHaveLength(1);
  });

  it("rejects invalid keys and preserves creation without a key", async () => {
    expect((await POST(request({ name: "Bad Key", ownerWalletAddress: owner }, "bad\nkey"))).status).toBe(400);
    expect((await POST(request({ name: "Long Key", ownerWalletAddress: owner }, "x".repeat(256)))).status).toBe(400);
    expect((await POST(request({ name: "Legacy", ownerWalletAddress: owner }))).status).toBe(201);
  });
});

function getRequest(query = "") {
  return new Request(`http://localhost/api/orgs${query ? `?${query}` : ""}`);
}

function seedExtraOrgs() {
  const extra = [
    { id: "org-same-b", name: "Same B", createdAt: "2026-04-02T00:00:00Z" },
    { id: "org-same-a", name: "Same A", createdAt: "2026-04-02T00:00:00Z" },
    { id: "org-zeta", name: "Zeta", createdAt: "2026-04-10T00:00:00Z" },
  ];
  for (const item of extra) {
    orgDb.orgs.set(item.id, {
      id: item.id,
      name: item.name,
      members: [{ walletAddress: owner, role: "owner", addedAt: item.createdAt }],
      policy: { ...DEFAULT_STREAM_POLICY },
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    });
  }
}

describe("GET /api/orgs pagination", () => {
  it("returns default page with pagination meta and omits member wallet addresses", async () => {
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual({ total: 2, hasNext: false, nextCursor: null });
    for (const org of body.data) {
      expect(org).not.toHaveProperty("members");
      expect(typeof org.memberCount).toBe("number");
    }
  });

  it("walks all pages with limit=1 in stable (createdAt, id) order without duplicates or gaps", async () => {
    seedExtraOrgs();

    const collected: string[] = [];
    let cursor: string | null = null;

    do {
      const query = cursor
        ? `limit=1&cursor=${encodeURIComponent(cursor)}`
        : "limit=1";
      const res = await GET(getRequest(query));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.meta.total).toBe(5);
      expect(body.data).toHaveLength(1);
      collected.push(body.data[0].id);
      cursor = body.meta.nextCursor;
      expect(body.meta.hasNext).toBe(cursor !== null);
    } while (cursor !== null);

    expect(collected).toEqual([
      "org-acme",
      "org-same-a",
      "org-same-b",
      "org-beta",
      "org-zeta",
    ]);
  });

  it("returns hasNext=false and nextCursor=null when total equals limit", async () => {
    const res = await GET(getRequest("limit=2"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.map((o: { id: string }) => o.id)).toEqual(["org-acme", "org-beta"]);
    expect(body.meta).toEqual({ total: 2, hasNext: false, nextCursor: null });
  });

  it("resumes cleanly when the org referenced by the cursor is removed", async () => {
    seedExtraOrgs();

    const first = await GET(getRequest("limit=2"));
    const firstBody = await first.json();
    expect(firstBody.data.map((o: { id: string }) => o.id)).toEqual([
      "org-acme",
      "org-same-a",
    ]);

    orgDb.orgs.delete("org-same-a");

    const second = await GET(
      getRequest(`limit=2&cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`),
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.map((o: { id: string }) => o.id)).toEqual([
      "org-same-b",
      "org-beta",
    ]);
    expect(secondBody.meta.hasNext).toBe(true);
  });

  it.each(["0", "-1", "101", "abc", "1.5"])(
    "returns 422 VALIDATION_ERROR for invalid limit=%s",
    async (limit) => {
      const res = await GET(getRequest(`limit=${limit}`));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    },
  );

  it("returns 422 INVALID_CURSOR for malformed cursor", async () => {
    const res = await GET(getRequest("cursor=not-a-valid-cursor"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });
});
