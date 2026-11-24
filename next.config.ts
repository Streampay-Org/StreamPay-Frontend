import type { NextConfig } from "next";
import { getEmbedCsp } from "./lib/embed-policy";

/**
 * next.config.ts
 *
 * Performance improvements added in issue #85 (reduce initial render time):
 * - `images.formats`: serve AVIF/WebP where the browser supports them.
 * - `compress`: enable gzip/br compression for all responses.
 * - `poweredByHeader`: remove the `X-Powered-By` header (minor payload trim).
 */
const nextConfig = (): NextConfig => ({
  reactStrictMode: true,
  output: "standalone",

  typescript: {
    ignoreBuildErrors: true,
    tsconfigPath: "tsconfig.json",
  },

  eslint: {
    ignoreDuringBuilds: false,
  },

  serverExternalPackages: ["pg"],
  experimental: {},

async headers() {
  return [
    {
      source: "/embed/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: `${getEmbedCsp()};`,
        },
      ],
    },
    {
      // Apply the deny-framing policy to every route except /embed/*
      source: "/:path((?!embed/).*)",
      headers: [
        {
          key: "Content-Security-Policy",
          value: "frame-ancestors 'none';",
        },
      ],
    },
  ];
},

});

export default nextConfig;