import {
  DEFAULT_ACCENT_COLOR,
  MAX_MESSAGE_LENGTH,
  RECEIPT_LOGO_ALLOWED_HOSTS_ENV,
  isSafeLogoUrl,
  isValidAccentColor,
  normalizeReceiptTheme,
} from "./receipt-theme";

describe("receipt-theme", () => {
  const originalAllowedHosts = process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV];

  afterEach(() => {
    if (originalAllowedHosts === undefined) {
      delete process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV];
    } else {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = originalAllowedHosts;
    }
  });

  describe("isValidAccentColor", () => {
    it("accepts 3- and 6-digit hex colours", () => {
      expect(isValidAccentColor("#fff")).toBe(true);
      expect(isValidAccentColor("#1f6feb")).toBe(true);
    });

    it("rejects malformed colours", () => {
      expect(isValidAccentColor("red")).toBe(false);
      expect(isValidAccentColor("#1234")).toBe(false);
      expect(isValidAccentColor(null)).toBe(false);
      expect(isValidAccentColor(undefined)).toBe(false);
    });
  });

  describe("isSafeLogoUrl", () => {
    it("fails closed when RECEIPT_LOGO_ALLOWED_HOSTS is unset or empty", () => {
      delete process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV];
      expect(isSafeLogoUrl("https://cdn.example.com/logo.png")).toBe(false);

      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "   ";
      expect(isSafeLogoUrl("https://cdn.example.com/logo.png")).toBe(false);
    });

    it("accepts exact allowlisted hosts and rejects disallowed hosts", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "cdn.example.com, assets.streampay.io";
      expect(isSafeLogoUrl("https://cdn.example.com/logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://assets.streampay.io/brand/mark.svg")).toBe(true);
      expect(isSafeLogoUrl("https://tracker.attacker.io/pixel.png")).toBe(false);
    });

    it("supports subdomain wildcards without matching apex or look-alike hosts", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "*.example.com";
      expect(isSafeLogoUrl("https://cdn.example.com/logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://img.cdn.example.com/logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://example.com/logo.png")).toBe(false);
      expect(isSafeLogoUrl("https://notexample.com/logo.png")).toBe(false);
      expect(isSafeLogoUrl("https://evil-cdn.example.com.attacker.io/logo.png")).toBe(false);
    });

    it("rejects embedded credentials and non-default ports", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "cdn.example.com";
      expect(isSafeLogoUrl("https://user:pass@cdn.example.com/logo.png")).toBe(false);
      expect(isSafeLogoUrl("https://user@cdn.example.com/logo.png")).toBe(false);
      expect(isSafeLogoUrl("https://cdn.example.com:8443/logo.png")).toBe(false);
      expect(isSafeLogoUrl("https://cdn.example.com:443/logo.png")).toBe(true);
    });

    it("handles uppercase hosts, trailing dots, and IDN/punycode hosts", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "CDN.EXAMPLE.COM, münchen.de";
      expect(isSafeLogoUrl("https://CDN.EXAMPLE.COM/logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://cdn.example.com./logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://münchen.de/logo.png")).toBe(true);
      expect(isSafeLogoUrl("https://xn--mnchen-3ya.de/logo.png")).toBe(true);
    });

    it("rejects unsafe or non-https URLs", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "cdn.example.com, *.example.com";
      expect(isSafeLogoUrl("http://cdn.example.com/logo.png")).toBe(false);
      expect(isSafeLogoUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeLogoUrl("data:image/png;base64,AAAA")).toBe(false);
      expect(isSafeLogoUrl("not a url")).toBe(false);
      expect(isSafeLogoUrl("")).toBe(false);
    });
  });

  describe("normalizeReceiptTheme", () => {
    it("falls back to defaults for empty input", () => {
      const theme = normalizeReceiptTheme();
      expect(theme.accentColor).toBe(DEFAULT_ACCENT_COLOR);
      expect(theme.logoUrl).toBeUndefined();
      expect(theme.message).toBeUndefined();
    });

    it("keeps valid customisation for allowlisted hosts and lowercases the colour", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "cdn.example.com";
      const theme = normalizeReceiptTheme({
        logoUrl: "https://cdn.example.com/logo.png",
        accentColor: "#AABBCC",
        message: "  Thanks!  ",
      });
      expect(theme.logoUrl).toBe("https://cdn.example.com/logo.png");
      expect(theme.accentColor).toBe("#aabbcc");
      expect(theme.message).toBe("Thanks!");
    });

    it("drops non-allowlisted logo URLs and invalid colours", () => {
      process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV] = "cdn.example.com";
      const theme = normalizeReceiptTheme({
        logoUrl: "https://evil-cdn.example.com.attacker.io/logo.png",
        accentColor: "purple",
      });
      expect(theme.logoUrl).toBeUndefined();
      expect(theme.accentColor).toBe(DEFAULT_ACCENT_COLOR);
    });

    it("drops logo URLs when allowlist env is unset", () => {
      delete process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV];
      const theme = normalizeReceiptTheme({
        logoUrl: "https://cdn.example.com/logo.png",
      });
      expect(theme.logoUrl).toBeUndefined();
    });

    it("truncates overly long messages with an ellipsis", () => {
      const theme = normalizeReceiptTheme({ message: "a".repeat(200) });
      expect(theme.message).toHaveLength(MAX_MESSAGE_LENGTH);
      expect(theme.message?.endsWith("…")).toBe(true);
    });
  });
});
