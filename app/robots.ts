import type { MetadataRoute } from "next";
import { getSiteUrl } from "./lib/site-url";

export const DISALLOWED_PATHS = [
  "/api/",
  "/activity",
  "/admin",
  "/audit",
  "/contacts",
  "/dashboard",
  "/design-qa",
  "/exports",
  "/orgs",
  "/settings",
  "/streams",
  "/templates",
] as const;

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [...DISALLOWED_PATHS],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
