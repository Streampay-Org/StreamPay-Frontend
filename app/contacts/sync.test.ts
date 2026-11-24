import { describe, it, expect } from "vitest";
import {
  mergeContacts,
  mergeContactsWithTombstones,
  type SyncedContact,
} from "./sync";

function contact(overrides: Partial<SyncedContact> = {}): SyncedContact {
  return {
    id: "c1",
    label: "Alice",
    address: "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZLPXE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeContacts", () => {
  it("returns the union of both lists when ids differ", () => {
    const local = [contact({ id: "a" })];
    const remote = [contact({ id: "b" })];
    const merged = mergeContacts(local, remote);
    expect(merged).toHaveLength(2);
  });

  it("keeps the remote version when remote is newer (last-write-wins)", () => {
    const local = [contact({ id: "a", label: "Local", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const remote = [contact({ id: "a", label: "Remote", updatedAt: "2026-01-02T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("Remote");
  });

  it("keeps the local version when local is newer", () => {
    const local = [contact({ id: "a", label: "Local", updatedAt: "2026-01-03T00:00:00.000Z" })];
    const remote = [contact({ id: "a", label: "Remote", updatedAt: "2026-01-02T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("Local");
  });

  it("prefers remote when timestamps are equal (server canonical)", () => {
    const local = [contact({ id: "a", label: "Local", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const remote = [contact({ id: "a", label: "Remote", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    expect(merged[0].label).toBe("Remote");
  });

  it("excludes tombstoned contacts from the result", () => {
    const local = [contact({ id: "a" })];
    const remote = [contact({ id: "b", deletedAt: "2026-01-05T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("a");
  });

  it("deletes do not resurrect: a tombstone wins over a local addition with older updatedAt", () => {
    const local = [contact({ id: "a", label: "Re-added", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const remote = [contact({ id: "a", label: "Old", deletedAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    // Remote has a later updatedAt AND a tombstone — it wins, contact stays deleted
    expect(merged).toHaveLength(0);
  });

  it("a local re-add after a tombstone resurrects when local is newer", () => {
    const local = [contact({ id: "a", label: "Re-added", updatedAt: "2026-06-01T00:00:00.000Z" })];
    const remote = [contact({ id: "a", label: "Old", deletedAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" })];
    const merged = mergeContacts(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("Re-added");
  });

  it("handles empty lists", () => {
    expect(mergeContacts([], [])).toHaveLength(0);
  });

  it("handles local-only list", () => {
    const local = [contact({ id: "a" }), contact({ id: "b" })];
    expect(mergeContacts(local, [])).toHaveLength(2);
  });

  it("handles remote-only list", () => {
    const remote = [contact({ id: "a" }), contact({ id: "b" })];
    expect(mergeContacts([], remote)).toHaveLength(2);
  });

  it("sorts results by createdAt ascending", () => {
    const local = [
      contact({ id: "c", createdAt: "2026-03-01T00:00:00.000Z" }),
      contact({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const remote = [
      contact({ id: "b", createdAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const merged = mergeContacts(local, remote);
    expect(merged.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("two devices adding different contacts converge to the union", () => {
    const deviceA = [contact({ id: "a", label: "Alice", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const deviceB = [contact({ id: "b", label: "Bob", updatedAt: "2026-01-02T00:00:00.000Z" })];
    const merged = mergeContacts(deviceA, deviceB);
    expect(merged).toHaveLength(2);
    const ids = merged.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("mergeContactsWithTombstones", () => {
  it("includes tombstoned contacts in the result", () => {
    const local = [contact({ id: "a" })];
    const remote = [contact({ id: "b", deletedAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" })];
    const merged = mergeContactsWithTombstones(local, remote);
    expect(merged).toHaveLength(2);
  });

  it("preserves tombstone when remote tombstone is newer", () => {
    const local = [contact({ id: "a", updatedAt: "2026-01-01T00:00:00.000Z" })];
    const remote = [contact({ id: "a", deletedAt: "2026-01-05T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" })];
    const merged = mergeContactsWithTombstones(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].deletedAt).toBeDefined();
  });
});
