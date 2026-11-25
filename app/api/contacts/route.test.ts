import { describe, it, expect, beforeEach } from "vitest";
import { GET, PUT } from "./route";
import { getStore, setStore, createDefaultStore } from "@/app/lib/db";
import { signToken } from "@/app/lib/auth";
import type { SyncedContact } from "@/app/contacts/sync";

function mockRequest(method: string, body: unknown, token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return {
    method,
    headers,
    json: async () => body,
  } as any;
}

function validContact(overrides: Partial<SyncedContact> = {}): SyncedContact {
  return {
    id: "c1",
    label: "Alice",
    address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/contacts", () => {
  beforeEach(() => {
    setStore(createDefaultStore());
  });

  it("returns 401 without auth", async () => {
    const res = await GET(mockRequest("GET", null));
    expect(res.status).toBe(401);
  });

  it("returns the wallet's contacts when authenticated", async () => {
    const token = signToken("GWALLET1");
    getStore().contactsStore.setForWallet("GWALLET1", [
      validContact({ id: "a" }),
      validContact({ id: "b", label: "Bob" }),
    ]);
    const res = await GET(mockRequest("GET", null, token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contacts).toHaveLength(2);
  });

  it("does not return another wallet's contacts (cross-wallet isolation)", async () => {
    const token = signToken("GWALLET1");
    getStore().contactsStore.setForWallet("GWALLET2", [
      validContact({ id: "secret" }),
    ]);
    const res = await GET(mockRequest("GET", null, token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contacts).toHaveLength(0);
  });

  it("excludes tombstoned contacts", async () => {
    const token = signToken("GWALLET1");
    getStore().contactsStore.setForWallet("GWALLET1", [
      validContact({ id: "a" }),
      validContact({ id: "b", deletedAt: "2026-01-05T00:00:00.000Z" }),
    ]);
    const res = await GET(mockRequest("GET", null, token));
    const data = await res.json();
    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0].id).toBe("a");
  });
});

describe("PUT /api/contacts", () => {
  beforeEach(() => {
    setStore(createDefaultStore());
  });

  it("returns 401 without auth", async () => {
    const res = await PUT(mockRequest("PUT", { contacts: [] }));
    expect(res.status).toBe(401);
  });

  it("replaces contacts for the authenticated wallet", async () => {
    const token = signToken("GWALLET1");
    const contacts = [validContact({ id: "a" }), validContact({ id: "b" })];
    const res = await PUT(mockRequest("PUT", { contacts }, token));
    expect(res.status).toBe(200);
    const stored = getStore().contactsStore.getForWallet("GWALLET1");
    expect(stored).toHaveLength(2);
  });

  it("returns 400 for invalid contact (bad address)", async () => {
    const token = signToken("GWALLET1");
    const contacts = [validContact({ id: "a", address: "INVALID" })];
    const res = await PUT(mockRequest("PUT", { contacts }, token));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing id", async () => {
    const token = signToken("GWALLET1");
    const contacts = [validContact({ id: "" })];
    const res = await PUT(mockRequest("PUT", { contacts }, token));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing createdAt", async () => {
    const token = signToken("GWALLET1");
    const contacts = [validContact({ id: "a", createdAt: "" })];
    const res = await PUT(mockRequest("PUT", { contacts }, token));
    expect(res.status).toBe(400);
  });

  it("does not affect another wallet's contacts", async () => {
    const token = signToken("GWALLET1");
    getStore().contactsStore.setForWallet("GWALLET2", [validContact({ id: "other" })]);
    const contacts = [validContact({ id: "a" })];
    await PUT(mockRequest("PUT", { contacts }, token));
    expect(getStore().contactsStore.getForWallet("GWALLET2")).toHaveLength(1);
    expect(getStore().contactsStore.getForWallet("GWALLET1")).toHaveLength(1);
  });
});
