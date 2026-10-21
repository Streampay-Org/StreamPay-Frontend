/**
 * @jest-environment node
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import openApiSpec from "../openapi.json";
import { loadOpenApiRoutes, type HttpMethod } from "../app/docs/openapi-routes";

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_API_DIR = path.join(REPO_ROOT, "app", "api");

/**
 * Explicit allowlist for internal, debug, and admin routes that do not need
 * public OpenAPI coverage.
 */
export const INTERNAL_ROUTE_ALLOWLIST: ReadonlyArray<string> = [
  "/api/internal/**",
  "/api/debug/**",
  "/api/admin/**",
];

/**
 * TODO(openapi-stream-lifecycle): Add OpenAPI 3.1 contract entries and response
 * examples for the remaining stream lifecycle, batch, orgs, reconciliation, and
 * webhook management routes in their dedicated workstreams.
 */
export const TODO_OTHER_WORKSTREAM_ROUTE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Stream lifecycle & batch operations (other workstream)
  "POST /api/streams/batch",
  "POST /api/streams/batch/start",
  "POST /api/streams/batch/stop",
  "POST /api/streams/dryrun",
  "GET /api/streams/events",
  "GET /api/streams/health",
  "POST /api/streams/import",
  "POST /api/streams/preview",
  "GET /api/streams/template",
  "POST /api/streams/template",
  "GET /api/streams/{id}/approvals",
  "POST /api/streams/{id}/approvals",
  "POST /api/streams/{id}/approvals/{approvalId}/approve",
  "POST /api/streams/{id}/cancel",
  "GET /api/streams/{id}/events",
  "POST /api/streams/{id}/webhooks/test",
  "POST /api/streams/{id}/withdraw",
  "POST /api/v2/streams/batch",
  "PATCH /api/v2/streams/{id}",
  // Organizations, reconciliation & webhook subscription management (other workstream)
  "GET /api/orgs",
  "POST /api/orgs",
  "GET /api/orgs/{orgId}",
  "GET /api/orgs/{orgId}/audit",
  "GET /api/orgs/{orgId}/members",
  "POST /api/orgs/{orgId}/members",
  "GET /api/orgs/{orgId}/token-allowlist",
  "PUT /api/orgs/{orgId}/token-allowlist",
  "POST /api/orgs/{orgId}/token-allowlist",
  "DELETE /api/orgs/{orgId}/token-allowlist",
  "GET /api/reconciliation",
  "GET /api/reconciliation/health",
  "GET /api/webhooks",
  "POST /api/webhooks",
  "POST /api/webhooks/dlq/{dlqId}/replay",
  "POST /api/webhooks/rotate",
]);

const DOCUMENTED_HTTP_METHODS: ReadonlyArray<HttpMethod> = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

/**
 * Maps a Next.js App Router `route.ts` path (or route path segment) to an
 * OpenAPI path template, converting `[id]` dynamic segments into `{id}`.
 */
export function mapRouteFileToOpenApiPath(
  routeFileOrRoutePath: string,
  apiDir: string = DEFAULT_API_DIR,
): string {
  const normalizedInput = routeFileOrRoutePath.replace(/\\/g, "/");

  if (normalizedInput.startsWith("/api/")) {
    return normalizedInput
      .replace(/\/route\.ts$/, "")
      .replace(/\[\.\.\.([^\]]+)\]/g, "{$1}")
      .replace(/\[([^\]]+)\]/g, "{$1}");
  }

  const relativeToApi = path
    .relative(apiDir, routeFileOrRoutePath)
    .replace(/\\/g, "/")
    .replace(/(?:^|\/)route\.ts$/, "");

  const converted = relativeToApi
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/^\[\.\.\.([^\]]+)\]$/, "{$1}")
        .replace(/^\[([^\]]+)\]$/, "{$1}"),
    )
    .join("/");

  return converted ? `/api/${converted}` : "/api";
}

/**
 * Checks whether an OpenAPI path matches any glob pattern in `INTERNAL_ROUTE_ALLOWLIST`
 * (e.g. `/api/internal/**`, `/api/debug/**`, `/api/admin/**`).
 */
export function isInternalAllowlistedPath(
  openApiPath: string,
  allowlist: ReadonlyArray<string> = INTERNAL_ROUTE_ALLOWLIST,
): boolean {
  return allowlist.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      return openApiPath === prefix || openApiPath.startsWith(`${prefix}/`);
    }
    return openApiPath === pattern;
  });
}

function extractFunctionBodies(source: string, method: HttpMethod): string[] {
  const bodies: string[] = [];
  const headerRegex = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+${method}\\b`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(source)) !== null) {
    // Find the opening brace of the function body after the parameter list
    let parenDepth = 0;
    let i = match.index + match[0].length;
    let bodyStart = -1;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "{" && parenDepth === 0) {
        bodyStart = i + 1;
        break;
      }
    }
    if (bodyStart === -1) continue;

    let braceDepth = 1;
    let j = bodyStart;
    for (; j < source.length && braceDepth > 0; j += 1) {
      if (source[j] === "{") braceDepth += 1;
      else if (source[j] === "}") braceDepth -= 1;
    }
    bodies.push(source.slice(bodyStart, j - 1));
  }
  return bodies;
}

/**
 * Extracts exported HTTP method handlers from a Next.js `route.ts` file,
 * ignoring `OPTIONS`/`HEAD` and explicit 405 `METHOD_NOT_ALLOWED` stubs.
 */
export function extractExportedHttpMethods(source: string): HttpMethod[] {
  const methods = new Set<HttpMethod>();

  for (const method of DOCUMENTED_HTTP_METHODS) {
    const bodies = extractFunctionBodies(source, method);
    if (bodies.length > 0) {
      for (const body of bodies) {
        const isMethodNotAllowedStub =
          body.includes("METHOD_NOT_ALLOWED") &&
          !/await\s+/.test(body) &&
          body.split("\n").length <= 12;
        if (!isMethodNotAllowedStub) {
          methods.add(method);
        }
      }
      continue;
    }

    const constOrReexportRegex = new RegExp(
      `export\\s+const\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`,
    );
    if (constOrReexportRegex.test(source)) {
      methods.add(method);
    }
  }

  return Array.from(methods);
}

function collectRouteFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRouteFiles(fullPath));
    } else if (entry.isFile() && entry.name === "route.ts") {
      results.push(fullPath);
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

export interface UndocumentedRoute {
  method: HttpMethod;
  path: string;
  file: string;
}

export function findUndocumentedPublicRoutes(options?: {
  apiDir?: string;
  spec?: typeof openApiSpec;
  internalAllowlist?: ReadonlyArray<string>;
  todoAllowlist?: ReadonlySet<string>;
}): UndocumentedRoute[] {
  const apiDir = options?.apiDir ?? DEFAULT_API_DIR;
  const spec = options?.spec ?? openApiSpec;
  const internalAllowlist = options?.internalAllowlist ?? INTERNAL_ROUTE_ALLOWLIST;
  const todoAllowlist = options?.todoAllowlist ?? TODO_OTHER_WORKSTREAM_ROUTE_ALLOWLIST;

  const documentedSet = new Set(
    loadOpenApiRoutes(spec as unknown as Parameters<typeof loadOpenApiRoutes>[0]).map(
      (entry) => `${entry.method} ${entry.path}`,
    ),
  );

  const routeFiles = collectRouteFiles(apiDir);
  const undocumented: UndocumentedRoute[] = [];

  for (const routeFile of routeFiles) {
    const openApiPath = mapRouteFileToOpenApiPath(routeFile, apiDir);
    if (isInternalAllowlistedPath(openApiPath, internalAllowlist)) {
      continue;
    }

    const source = fs.readFileSync(routeFile, "utf8");
    const methods = extractExportedHttpMethods(source);

    for (const method of methods) {
      const key = `${method} ${openApiPath}`;
      if (todoAllowlist.has(key)) {
        continue;
      }
      if (!documentedSet.has(key)) {
        undocumented.push({
          method,
          path: openApiPath,
          file: path.relative(REPO_ROOT, routeFile).replace(/\\/g, "/"),
        });
      }
    }
  }

  return undocumented;
}

export function formatCoverageFailureMessage(missing: ReadonlyArray<UndocumentedRoute>): string {
  if (missing.length === 0) return "";
  const lines = missing.map((item) => `  - ${item.method} ${item.path} (${item.file})`);
  return [
    `Found ${missing.length} public API route operation(s) missing from openapi.json:`,
    ...lines,
    "Add each route to openapi.json and run `npm run openapi:generate`, or allowlist internal/pending routes.",
  ].join("\n");
}

describe("openapi route coverage and drift detection", () => {
  it("maps [id] dynamic route segments to {id} OpenAPI path templates", () => {
    expect(mapRouteFileToOpenApiPath("/api/streams/[id]/pause")).toBe(
      "/api/streams/{id}/pause",
    );
    expect(
      mapRouteFileToOpenApiPath(
        path.join(DEFAULT_API_DIR, "streams", "[id]", "pause", "route.ts"),
        DEFAULT_API_DIR,
      ),
    ).toBe("/api/streams/{id}/pause");
  });

  it("ignores internal, debug, and admin routes through INTERNAL_ROUTE_ALLOWLIST", () => {
    expect(isInternalAllowlistedPath("/api/internal/Flags")).toBe(true);
    expect(isInternalAllowlistedPath("/api/internal/kms-Health")).toBe(true);
    expect(isInternalAllowlistedPath("/api/debug/kms-sign")).toBe(true);
    expect(isInternalAllowlistedPath("/api/admin/circuit-breaker")).toBe(true);
    expect(isInternalAllowlistedPath("/api/healthz")).toBe(false);
    expect(isInternalAllowlistedPath("/api/streams")).toBe(false);
  });

  it("fails with a clear message when a fake public route file is added in a fixture directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-drift-fixture-"));
    try {
      const fakeRouteDir = path.join(tempDir, "widgets", "[id]");
      fs.mkdirSync(fakeRouteDir, { recursive: true });
      const fakeRouteFile = path.join(fakeRouteDir, "route.ts");
      fs.writeFileSync(
        fakeRouteFile,
        `export async function GET() { return Response.json({ ok: true }); }\n` +
          `export async function POST() { return Response.json({ created: true }); }\n`,
        "utf8",
      );

      const missing = findUndocumentedPublicRoutes({ apiDir: tempDir });
      expect(missing).toEqual([
        expect.objectContaining({
          method: "GET",
          path: "/api/widgets/{id}",
        }),
        expect.objectContaining({
          method: "POST",
          path: "/api/widgets/{id}",
        }),
      ]);

      const message = formatCoverageFailureMessage(missing);
      expect(message).toContain(
        "Found 2 public API route operation(s) missing from openapi.json:",
      );
      expect(message).toContain("GET /api/widgets/{id}");
      expect(message).toContain("POST /api/widgets/{id}");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("documents every public app/api/**/route.ts handler in openapi.json", () => {
    const missing = findUndocumentedPublicRoutes();
    if (missing.length > 0) {
      throw new Error(formatCoverageFailureMessage(missing));
    }
    expect(missing).toEqual([]);
  });

  it("removes the hardcoded apiRoutes table from app/docs/page.tsx", () => {
    const docsPageSource = fs.readFileSync(
      path.join(REPO_ROOT, "app", "docs", "page.tsx"),
      "utf8",
    );
    expect(docsPageSource).not.toContain("apiRoutes");
  });
});
