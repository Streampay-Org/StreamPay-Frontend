import { filterContacts, sortContacts, type SortableContact } from "./filter";

const contacts: SortableContact[] = [
  {
    label: "Élodie",
    address: "GZZZ",
    federationAddress: "elodie*example.com",
    memo: "Design",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    label: "alice",
    address: "GAAA",
    memo: "Payments",
    createdAt: "2026-01-03T00:00:00.000Z",
  },
  {
    label: "Bob",
    address: "GBBB",
    memo: "Contractor",
    createdAt: "invalid",
  },
];

describe("contact filter functions", () => {
  it("trims and ignores case in search queries", () => {
    expect(filterContacts(contacts, "   ")).toHaveLength(3);
  });

  it("searches label, address, federation address, and memo", () => {
    expect(filterContacts(contacts, "ELODIE").map((contact) => contact.label)).toEqual(["Élodie"]);
    expect(filterContacts(contacts, "gzzz").map((contact) => contact.label)).toEqual(["Élodie"]);
    expect(filterContacts(contacts, "elodie*example").map((contact) => contact.label)).toEqual(["Élodie"]);
    expect(filterContacts(contacts, "contractor").map((contact) => contact.label)).toEqual(["Bob"]);
  });

  it("sorts labels in both directions with accent-insensitive comparison", () => {
    expect(sortContacts(contacts, "label-asc").map((contact) => contact.label)).toEqual([
      "alice",
      "Bob",
      "Élodie",
    ]);
    expect(sortContacts(contacts, "label-desc").map((contact) => contact.label)).toEqual([
      "Élodie",
      "Bob",
      "alice",
    ]);
  });

  it("sorts by recency and keeps ties stable", () => {
    const tied = [
      { ...contacts[0], label: "First", createdAt: "2026-01-01T00:00:00.000Z" },
      { ...contacts[1], label: "Second", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(sortContacts(tied, "recent").map((contact) => contact.label)).toEqual([
      "First",
      "Second",
    ]);
    expect(sortContacts(tied, "oldest").map((contact) => contact.label)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("handles missing and invalid createdAt values safely", () => {
    const values: SortableContact[] = [
      { label: "Valid", address: "G1", createdAt: "2026-01-01T00:00:00.000Z" },
      { label: "Invalid", address: "G2", createdAt: "not-a-date" },
      { label: "Missing", address: "G3", createdAt: "" },
    ];
    expect(sortContacts(values, "recent").map((contact) => contact.label)).toEqual([
      "Valid",
      "Invalid",
      "Missing",
    ]);
    expect(sortContacts(values, "oldest").map((contact) => contact.label)).toEqual([
      "Valid",
      "Invalid",
      "Missing",
    ]);
  });

  it("does not mutate the source list", () => {
    const original = [...contacts];
    sortContacts(contacts, "label-desc");
    filterContacts(contacts, "alice");
    expect(contacts).toEqual(original);
  });
});
