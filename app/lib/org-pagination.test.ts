/** @jest-environment node */

import {
  DEFAULT_ORG_PAGE_LIMIT,
  InvalidOrgCursorError,
  decodeOrgCursor,
  encodeOrgCursor,
  paginateByKeyset,
  parseOrgPaginationParams,
} from "@/app/lib/org-pagination";

interface TestItem {
  id: string;
  createdAt: string;
}

describe("org-pagination", () => {
  describe("encodeOrgCursor / decodeOrgCursor", () => {
    it("round-trips a valid cursor", () => {
      const cursor = { timestamp: "2026-04-01T00:00:00Z", id: "org-acme" };
      const encoded = encodeOrgCursor(cursor);
      expect(decodeOrgCursor(encoded)).toEqual(cursor);
    });

    it("rejects empty, non-base64, and malformed cursors", () => {
      expect(() => decodeOrgCursor("")).toThrow(InvalidOrgCursorError);
      expect(() => decodeOrgCursor("not!valid!base64")).toThrow(InvalidOrgCursorError);
      expect(() =>
        decodeOrgCursor(Buffer.from("no-separator").toString("base64")),
      ).toThrow(InvalidOrgCursorError);
      expect(() =>
        decodeOrgCursor(Buffer.from("not-a-timestamp|org-1").toString("base64")),
      ).toThrow(InvalidOrgCursorError);
      expect(() =>
        decodeOrgCursor(
          Buffer.from("2026-04-01T00:00:00Z|bad id with spaces").toString("base64"),
        ),
      ).toThrow(InvalidOrgCursorError);
    });
  });

  describe("parseOrgPaginationParams", () => {
    it("defaults limit to 20 and cursor to null", () => {
      const result = parseOrgPaginationParams(new URLSearchParams());
      expect(result).toEqual({
        ok: true,
        value: { limit: DEFAULT_ORG_PAGE_LIMIT, cursor: null },
      });
    });

    it("accepts boundary limits 1 and 100", () => {
      expect(parseOrgPaginationParams(new URLSearchParams("limit=1"))).toEqual({
        ok: true,
        value: { limit: 1, cursor: null },
      });
      expect(parseOrgPaginationParams(new URLSearchParams("limit=100"))).toEqual({
        ok: true,
        value: { limit: 100, cursor: null },
      });
    });

    it.each(["0", "-5", "101", "abc", "1.5", ""])(
      "returns VALIDATION_ERROR for invalid limit %j",
      (rawLimit) => {
        const params = new URLSearchParams();
        params.set("limit", rawLimit);
        const result = parseOrgPaginationParams(params);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe("VALIDATION_ERROR");
        }
      },
    );

    it("returns INVALID_CURSOR for malformed or empty cursor", () => {
      const bad = parseOrgPaginationParams(new URLSearchParams("cursor=!!!"));
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.code).toBe("INVALID_CURSOR");

      const empty = parseOrgPaginationParams(new URLSearchParams("cursor="));
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.code).toBe("INVALID_CURSOR");
    });
  });

  describe("paginateByKeyset", () => {
    const items: TestItem[] = [
      { id: "org-c", createdAt: "2026-04-02T00:00:00Z" },
      { id: "org-b", createdAt: "2026-04-01T00:00:00Z" },
      { id: "org-a", createdAt: "2026-04-01T00:00:00Z" },
      { id: "org-d", createdAt: "2026-04-03T00:00:00Z" },
    ];
    const getKey = (item: TestItem) => ({ timestamp: item.createdAt, id: item.id });

    it("handles an empty collection", () => {
      expect(paginateByKeyset([], getKey, { limit: 20 })).toEqual({
        page: [],
        hasNext: false,
        nextCursor: null,
      });
    });

    it("returns hasNext=false and nextCursor=null when items.length === limit", () => {
      const result = paginateByKeyset(items, getKey, { limit: 4 });
      expect(result.page.map((i) => i.id)).toEqual(["org-a", "org-b", "org-c", "org-d"]);
      expect(result.hasNext).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("walks all pages with limit=1 in stable (createdAt, id) order without duplicates or gaps", () => {
      const collected: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const result = paginateByKeyset(items, getKey, {
          limit: 1,
          cursor: cursor ? decodeOrgCursor(cursor) : null,
        });
        collected.push(...result.page.map((i) => i.id));
        cursor = result.nextCursor;
        pages += 1;
        if (result.hasNext) {
          expect(cursor).not.toBeNull();
        } else {
          expect(cursor).toBeNull();
        }
      } while (cursor !== null);

      expect(pages).toBe(4);
      expect(collected).toEqual(["org-a", "org-b", "org-c", "org-d"]);
    });

    it("resumes cleanly when the item referenced by the cursor has been removed", () => {
      const firstPage = paginateByKeyset(items, getKey, { limit: 2 });
      expect(firstPage.page.map((i) => i.id)).toEqual(["org-a", "org-b"]);
      expect(firstPage.nextCursor).not.toBeNull();

      // Remove org-b (the cursor anchor) before fetching the next page.
      const remaining = items.filter((i) => i.id !== "org-b");
      const secondPage = paginateByKeyset(remaining, getKey, {
        limit: 2,
        cursor: decodeOrgCursor(firstPage.nextCursor!),
      });
      expect(secondPage.page.map((i) => i.id)).toEqual(["org-c", "org-d"]);
      expect(secondPage.hasNext).toBe(false);
      expect(secondPage.nextCursor).toBeNull();
    });
  });
});
