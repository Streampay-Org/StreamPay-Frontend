/** @jest-environment node */

import { POST } from "@/app/api/orgs/route";
import { orgDb, _resetOrgDbForTesting } from "@/app/lib/org-db";
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
