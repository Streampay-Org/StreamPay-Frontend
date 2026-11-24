import {
  hashSeed,
  getIdenticonPaletteIndex,
  getRecipientInitials,
  getRecipientIdenticon,
  IDENTICON_PALETTE_SIZE,
} from "./identicon";

describe("hashSeed", () => {
  it("is deterministic for the same input", () => {
    expect(hashSeed("Ada Creative Studio")).toBe(hashSeed("Ada Creative Studio"));
  });

  it("returns a non-negative 32-bit integer", () => {
    const hash = hashSeed("GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G");
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("produces different hashes for different inputs (no trivial collisions)", () => {
    const seeds = ["Ada Creative Studio", "Kemi Onboarding Support", "Yusuf QA Partnership"];
    const hashes = new Set(seeds.map(hashSeed));
    expect(hashes.size).toBe(seeds.length);
  });

  it("handles an empty string without throwing", () => {
    expect(() => hashSeed("")).not.toThrow();
  });
});

describe("getIdenticonPaletteIndex", () => {
  it("is deterministic for the same recipient", () => {
    const recipient = "Ada Creative Studio";
    expect(getIdenticonPaletteIndex(recipient)).toBe(getIdenticonPaletteIndex(recipient));
  });

  it("always returns an index within the palette bounds", () => {
    const recipients = [
      "Ada Creative Studio",
      "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G",
      "",
      "z",
      "A very long recipient display name with lots of words in it",
    ];
    for (const recipient of recipients) {
      const index = getIdenticonPaletteIndex(recipient);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(IDENTICON_PALETTE_SIZE);
    }
  });

  it("returns 0 for an empty recipient", () => {
    expect(getIdenticonPaletteIndex("")).toBe(0);
  });
});

describe("getRecipientInitials", () => {
  it("uses the first letter of up to two words for display names", () => {
    expect(getRecipientInitials("Ada Creative Studio")).toBe("AC");
    expect(getRecipientInitials("Kemi Onboarding Support")).toBe("KO");
  });

  it("uppercases initials from lowercase names", () => {
    expect(getRecipientInitials("yusuf qa partnership")).toBe("YQ");
  });

  it("handles a single-word name", () => {
    expect(getRecipientInitials("Streampay")).toBe("S");
  });

  it("derives initials from a Stellar public key without treating it as words", () => {
    expect(getRecipientInitials("GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3JKAKZK7G")).toBe(
      "GA"
    );
  });

  it("falls back to '?' for empty or whitespace-only input", () => {
    expect(getRecipientInitials("")).toBe("?");
    expect(getRecipientInitials("   ")).toBe("?");
  });

  it("trims surrounding whitespace before deriving initials", () => {
    expect(getRecipientInitials("  Ada Creative Studio  ")).toBe("AC");
  });
});

describe("getRecipientIdenticon", () => {
  it("combines initials and a palette index deterministically", () => {
    const a = getRecipientIdenticon("Ada Creative Studio");
    const b = getRecipientIdenticon("Ada Creative Studio");
    expect(a).toEqual(b);
    expect(a.initials).toBe("AC");
    expect(a.paletteIndex).toBeGreaterThanOrEqual(0);
    expect(a.paletteIndex).toBeLessThan(IDENTICON_PALETTE_SIZE);
  });
});
