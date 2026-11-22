/**
 * @jest-environment node
 *
 * Documentation contract test for `docs/rate-limits.md`.
 *
 * Guards against drift between `ROUTE_LIMITS` in
 * `app/lib/rate-limit-config.ts` and the "Rate Limited Endpoints" table in
 * `docs/rate-limits.md`.
 */

import { readFileSync } from "fs";
import { join } from "path";

import { ROUTE_LIMITS } from "@/app/lib/rate-limit-config";

const DOC_PATH = join(__dirname, "..", "rate-limits.md");
const doc = readFileSync(DOC_PATH, "utf8");

/**
 * Normalise a `ROUTE_LIMITS` key (`METHOD:/path`) to the form used in
 * `docs/rate-limits.md`:
 *   - strip a trailing `/` (unless the path is `"/"`)
 *   - map `*` wildcards to `{id}`
 */
export function normaliseRouteKey(key: string): { method: string; path: string } {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid ROUTE_LIMITS key (missing ":"): ${key}`);
  }

  const method = key.slice(0, colonIndex).trim().toUpperCase();
  let path = key.slice(colonIndex + 1).trim();

  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  path = path.replace(/\*/g, "{id}");

  return { method, path };
}

/**
 * Extract all `METHOD:/path` pairs from markdown table rows of the form:
 *   | METHOD | `/path` | ... |
 */
export function extractDocumentedRoutes(markdown: string): Set<string> {
  const documented = new Set<string>();
  const rowPattern = /^\|\s*([A-Z]+)\s*\|\s*`([^`]+)`\s*\|/gm;

  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(markdown)) !== null) {
    const method = match[1].trim().toUpperCase();
    const path = match[2].trim();
    documented.add(`${method}:${path}`);
  }

  return documented;
}

describe("docs/rate-limits.md contract", () => {
  it("normalises trailing slashes and mid-path wildcards", () => {
    expect(normaliseRouteKey("GET:/api/streams/")).toEqual({
      method: "GET",
      path: "/api/streams",
    });
    expect(normaliseRouteKey("POST:/api/streams/*/start")).toEqual({
      method: "POST",
      path: "/api/streams/{id}/start",
    });
  });

  it("documents every ROUTE_LIMITS entry in the Rate Limited Endpoints table", () => {
    const documented = extractDocumentedRoutes(doc);
    const missing: string[] = [];

    for (const [key, limitType] of Object.entries(ROUTE_LIMITS)) {
      const { method, path } = normaliseRouteKey(key);
      const normalised = `${method}:${path}`;
      if (!documented.has(normalised)) {
        missing.push(`${normalised} (config key: "${key}", limitType: "${limitType}")`);
      }
    }

    expect(missing).toEqual([]);
  });
});
