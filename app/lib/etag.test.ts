import { canonicalize, computeETag, ifNoneMatchMatches } from "./etag";

describe("etag helpers", () => {
  describe("canonicalize", () => {
    it("sorts object keys deterministically", () => {
      const a = canonicalize({ b: 1, a: 2, c: 3 });
      const b = canonicalize({ c: 3, a: 2, b: 1 });
      expect(a).toBe(b);
      expect(a).toBe('{"a":2,"b":1,"c":3}');
    });

    it("preserves array order", () => {
      expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
      expect(canonicalize([3, 2, 1])).toBe("[3,2,1]");
    });

    it("treats null and undefined as the same canonical token", () => {
      // Latent-defensive: absent fields should hash identically to
      // explicit-null fields to keep the ETag space deterministic.
      expect(canonicalize(undefined)).toBe(canonicalize(null));
      expect(canonicalize(undefined)).toBe("null");
    });

    it("handles nested structures", () => {
      const value = { outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
      expect(canonicalize(value)).toBe(
        '{"list":[{"x":2,"y":1}],"outer":{"a":2,"z":1}}'
      );
    });

    it("encodes primitives", () => {
      expect(canonicalize("hello")).toBe('"hello"');
      expect(canonicalize(42)).toBe("42");
      expect(canonicalize(true)).toBe("true");
      expect(canonicalize(null)).toBe("null");
    });
  });

  describe("computeETag", () => {
    it("returns a strong RFC 7232 entity-tag", () => {
      const tag = computeETag("org-acme", { id: "stream-1" });
      expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
    });

    it("is stable for semantically equal inputs", () => {
      const t1 = computeETag("org-a", { id: "1", updatedAt: "x", nested: { a: 1 } });
      const t2 = computeETag("org-a", { nested: { a: 1 }, updatedAt: "x", id: "1" });
      expect(t1).toBe(t2);
    });

    it("produces different tags across tenants (prevents cross-tenant poisoning)", () => {
      const t1 = computeETag("org-a", { id: "stream-1" });
      const t2 = computeETag("org-b", { id: "stream-1" });
      expect(t1).not.toBe(t2);
    });

    it("throws when tenant is missing", () => {
      expect(() => computeETag("", { id: "1" })).toThrow();
      expect(() => computeETag("   ", { id: "1" })).toThrow();
    });
  });

  describe("ifNoneMatchMatches", () => {
    const tag = `"abc123"`;

    it("returns false when header is missing or empty", () => {
      expect(ifNoneMatchMatches(null, tag)).toBe(false);
      expect(ifNoneMatchMatches("", tag)).toBe(false);
    });

    it("matches wildcard '*' regardless of current tag", () => {
      expect(ifNoneMatchMatches("*", tag)).toBe(true);
      expect(ifNoneMatchMatches(" * ", tag)).toBe(true);
    });

    it("matches exact strong tags", () => {
      expect(ifNoneMatchMatches(`"abc123"`, tag)).toBe(true);
    });

    it("matches weak-form variants (weak comparison is used for If-None-Match)", () => {
      expect(ifNoneMatchMatches(`W/"abc123"`, tag)).toBe(true);
    });

    it("matches any entry in a comma-separated list", () => {
      expect(ifNoneMatchMatches(`"other", "abc123", W/"nope"`, tag)).toBe(true);
    });

    it("returns false for non-matching tags", () => {
      expect(ifNoneMatchMatches(`"different"`, tag)).toBe(false);
    });

    it("tolerates malformed entries without throwing", () => {
      // Each malformed candidate is ignored; the comparator falls back to false
      // rather than crashing the request handler.
      expect(ifNoneMatchMatches(`garbage`, tag)).toBe(false);
      expect(ifNoneMatchMatches(`"unterminated, "abc123"`, tag)).toBe(true);
    });
  });
});
