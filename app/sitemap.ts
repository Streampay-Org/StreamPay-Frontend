import type { MetadataRoute } from "next";
import { getSiteUrl } from "./lib/site-url";

export const PUBLIC_ROUTES = ["/", "/docs", "/help", "/onboarding"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: new URL(route, siteUrl).toString(),
    lastModified,
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
