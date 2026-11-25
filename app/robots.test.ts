import robots, { DISALLOWED_PATHS } from "./robots";
import { DEFAULT_SITE_URL } from "./lib/site-url";

describe("robots metadata route", () => {
  const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
    (process.env as Record<string, string | undefined>).NODE_ENV =
      originalNodeEnv;
  });

  it("uses the configured NEXT_PUBLIC_SITE_URL and strips trailing slashes", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://streampay.example.com/";

    const result = robots();

    expect(result.sitemap).toBe("https://streampay.example.com/sitemap.xml");
  });

  it("falls back to the default origin when NEXT_PUBLIC_SITE_URL is missing or invalid", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);

    process.env.NEXT_PUBLIC_SITE_URL = "not-a-valid-url";
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });

  it("rejects non-HTTPS origins in production without throwing", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.NEXT_PUBLIC_SITE_URL = "http://streampay.example.com";

    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });

  it("allows public pages and disallows API and authenticated areas", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const wildcardRule = rules.find((rule) => rule.userAgent === "*");

    expect(wildcardRule).toBeDefined();
    expect(wildcardRule?.allow).toBe("/");
    expect(wildcardRule?.disallow).toEqual(
      expect.arrayContaining([
        "/api/",
        "/settings",
        "/streams",
        "/activity",
        "/contacts",
        "/templates",
      ])
    );
    expect(wildcardRule?.disallow).toEqual([...DISALLOWED_PATHS]);
  });
});
