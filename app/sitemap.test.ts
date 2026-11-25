import sitemap, { PUBLIC_ROUTES } from "./sitemap";
import { DEFAULT_SITE_URL } from "./lib/site-url";

describe("sitemap metadata route", () => {
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

  it("lists only public routes with lastModified using the configured origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://streampay.example.com/";

    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);

    expect(entries).toHaveLength(PUBLIC_ROUTES.length);
    expect(urls).toEqual([
      "https://streampay.example.com/",
      "https://streampay.example.com/docs",
      "https://streampay.example.com/help",
      "https://streampay.example.com/onboarding",
    ]);

    for (const entry of entries) {
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it("does not include API or authenticated application routes", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://streampay.example.com";

    const urls = sitemap().map((entry) => entry.url);

    for (const forbidden of [
      "/api",
      "/settings",
      "/streams",
      "/activity",
      "/contacts",
      "/templates",
      "/admin",
    ]) {
      expect(urls.some((url) => url.includes(forbidden))).toBe(false);
    }
  });

  it("falls back safely when NEXT_PUBLIC_SITE_URL is invalid or non-HTTPS in production", () => {
    process.env.NEXT_PUBLIC_SITE_URL = ":::bad-url:::";
    expect(sitemap()[0].url).toBe(`${DEFAULT_SITE_URL}/`);

    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.NEXT_PUBLIC_SITE_URL = "http://streampay.example.com";
    expect(sitemap()[0].url).toBe(`${DEFAULT_SITE_URL}/`);
  });
});
