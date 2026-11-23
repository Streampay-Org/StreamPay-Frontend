import { FAQ_SECTIONS } from "./faq-data";

const URL_SAFE_ID = /^[a-z0-9-]+$/;
const HTML_TAG = /<[^>]+>/;

describe("FAQ_SECTIONS data integrity", () => {
  const allItems = FAQ_SECTIONS.flatMap((section) => section.items);

  it("contains at least one section", () => {
    expect(FAQ_SECTIONS.length).toBeGreaterThan(0);
  });

  it("has unique, URL-safe section ids", () => {
    const seen = new Set<string>();

    for (const section of FAQ_SECTIONS) {
      expect(section.id).toMatch(URL_SAFE_ID);
      expect(seen.has(section.id)).toBe(false);
      seen.add(section.id);
    }
  });

  it("has unique, URL-safe item ids across all sections", () => {
    const seen = new Set<string>();

    for (const item of allItems) {
      expect(item.id).toMatch(URL_SAFE_ID);
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
  });

  it("has non-empty section titles and at least one item per section", () => {
    for (const section of FAQ_SECTIONS) {
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("has non-empty trimmed questions and answers for every item", () => {
    for (const item of allItems) {
      expect(item.question.trim().length).toBeGreaterThan(0);
      expect(item.answer.trim().length).toBeGreaterThan(0);
    }
  });

  it("contains no raw HTML tags in questions or answers", () => {
    // Plain-text only today; if markup (e.g. <kbd>) or internal links are
    // introduced later, update this test deliberately with an allowlist or
    // route validation.
    for (const item of allItems) {
      expect(item.question).not.toMatch(HTML_TAG);
      expect(item.answer).not.toMatch(HTML_TAG);
    }
  });

  it("has unique (case-insensitive) questions ending with a question mark", () => {
    const seen = new Set<string>();

    for (const item of allItems) {
      const normalized = item.question.trim().toLowerCase();
      expect(item.question.trim().endsWith("?")).toBe(true);
      expect(seen.has(normalized)).toBe(false);
      seen.add(normalized);
    }
  });
});
