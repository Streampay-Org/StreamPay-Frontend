import { CHECKLIST_SECTIONS, TOTAL_ITEMS } from "./checklist-data";

describe("design-qa checklist-data integrity", () => {
  it("exports at least one checklist section", () => {
    expect(CHECKLIST_SECTIONS.length).toBeGreaterThan(0);
  });

  it("has unique, non-empty section ids", () => {
    const sectionIds = CHECKLIST_SECTIONS.map((section) => section.id);
    for (const id of sectionIds) {
      expect(id.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
  });

  it("has unique, non-empty item ids across all sections", () => {
    const allItemIds = CHECKLIST_SECTIONS.flatMap((section) =>
      section.items.map((entry) => entry.id)
    );
    for (const id of allItemIds) {
      expect(id.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(allItemIds).size).toBe(allItemIds.length);
  });

  it("uses a consistent, section-scoped <prefix>-<n> convention for item ids", () => {
    const seenPrefixes = new Set<string>();

    for (const section of CHECKLIST_SECTIONS) {
      const prefixesInSection = new Set<string>();

      for (const entry of section.items) {
        const match = /^([a-z0-9]+)-(\d+)$/.exec(entry.id);
        expect(match).not.toBeNull();
        if (match) {
          prefixesInSection.add(match[1]);
        }
      }

      // Every item in a section shares a single prefix
      expect(prefixesInSection.size).toBe(1);
      const [prefix] = Array.from(prefixesInSection);

      // No two sections share the same item-id prefix
      expect(seenPrefixes.has(prefix)).toBe(false);
      seenPrefixes.add(prefix);
    }
  });

  it("has non-empty titles, at least one item per section, and non-empty text/optional fields", () => {
    for (const section of CHECKLIST_SECTIONS) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.items.length).toBeGreaterThan(0);

      if (section.description !== undefined) {
        expect(section.description.trim().length).toBeGreaterThan(0);
      }

      for (const entry of section.items) {
        expect(entry.item.trim().length).toBeGreaterThan(0);
        if (entry.annotation !== undefined) {
          expect(entry.annotation.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("sets TOTAL_ITEMS equal to the actual number of checklist items", () => {
    const actualCount = CHECKLIST_SECTIONS.reduce(
      (sum, section) => sum + section.items.length,
      0
    );
    expect(TOTAL_ITEMS).toBe(actualCount);
    expect(TOTAL_ITEMS).toBeGreaterThan(0);
  });

  it("keeps numeric item-count claims in section descriptions in sync with item counts", () => {
    for (const section of CHECKLIST_SECTIONS) {
      if (!section.description) continue;
      const match = /\b(\d+)\s+items?\b/i.exec(section.description);
      if (match) {
        expect(Number(match[1])).toBe(section.items.length);
      }
    }
  });
});
