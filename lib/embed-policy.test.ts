import {
  buildEmbedCsp,
  parseEmbedAllowedOrigins,
} from "./embed-policy";

describe("parseEmbedAllowedOrigins", () => {
  it("accepts valid HTTPS origins", () => {
    expect(
      parseEmbedAllowedOrigins(
        "https://example.com, https://shop.example.com",
      ),
    ).toEqual(["https://example.com", "https://shop.example.com"]);
  });

  it("removes duplicate origins", () => {
    expect(
      parseEmbedAllowedOrigins(
        "https://example.com,https://example.com",
      ),
    ).toEqual(["https://example.com"]);
  });

  it("rejects HTTP, wildcards, paths, and malformed values", () => {
    expect(
      parseEmbedAllowedOrigins(
        "http://example.com, https://*.example.com, https://example.com/path, invalid",
      ),
    ).toEqual([]);
  });

  it("returns an empty list when the setting is missing", () => {
    expect(parseEmbedAllowedOrigins(undefined)).toEqual([]);
    expect(parseEmbedAllowedOrigins("  ")).toEqual([]);
  });
});

describe("buildEmbedCsp", () => {
  it("allows configured origins", () => {
    expect(
      buildEmbedCsp(["https://example.com", "https://shop.example.com"]),
    ).toBe(
      "frame-ancestors https://example.com https://shop.example.com",
    );
  });

  it("denies framing when no origins are configured", () => {
    expect(buildEmbedCsp([])).toBe("frame-ancestors 'none'");
  });
});
