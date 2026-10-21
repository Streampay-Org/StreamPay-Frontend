import openApiSpec from "../../openapi.json";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface OpenApiRouteEntry {
  method: HttpMethod;
  path: string;
  summary: string;
  security: boolean;
  tag: string;
  tags: string[];
}

export interface OpenApiRouteGroup {
  tag: string;
  description?: string;
  routes: OpenApiRouteEntry[];
}

interface RawOperation {
  summary?: string;
  description?: string;
  security?: ReadonlyArray<Record<string, unknown>>;
  tags?: ReadonlyArray<string>;
}

interface RawPathItem {
  security?: ReadonlyArray<Record<string, unknown>>;
  get?: RawOperation;
  post?: RawOperation;
  put?: RawOperation;
  patch?: RawOperation;
  delete?: RawOperation;
  options?: RawOperation;
  head?: RawOperation;
}

interface RawOpenApiSpec {
  security?: ReadonlyArray<Record<string, unknown>>;
  paths?: Record<string, RawPathItem | undefined>;
  tags?: ReadonlyArray<{ name: string; description?: string }>;
}

const HTTP_METHODS: ReadonlyArray<{
  key: keyof Pick<RawPathItem, "get" | "post" | "put" | "patch" | "delete" | "options" | "head">;
  method: HttpMethod;
}> = [
  { key: "get", method: "GET" },
  { key: "post", method: "POST" },
  { key: "put", method: "PUT" },
  { key: "patch", method: "PATCH" },
  { key: "delete", method: "DELETE" },
  { key: "options", method: "OPTIONS" },
  { key: "head", method: "HEAD" },
];

function requiresAuth(
  operation: RawOperation,
  pathItem: RawPathItem,
  spec: RawOpenApiSpec,
): boolean {
  const effectiveSecurity = operation.security ?? pathItem.security ?? spec.security ?? [];
  return Array.isArray(effectiveSecurity) && effectiveSecurity.length > 0;
}

/**
 * Loads all route operations from `openapi.json` at build time, sorted by `path`.
 */
export function loadOpenApiRoutes(
  spec: RawOpenApiSpec = openApiSpec as unknown as RawOpenApiSpec,
): OpenApiRouteEntry[] {
  const paths = spec.paths ?? {};
  const entries: OpenApiRouteEntry[] = [];

  const sortedPaths = Object.keys(paths).sort((a, b) => a.localeCompare(b));

  for (const path of sortedPaths) {
    const pathItem = paths[path];
    if (!pathItem) continue;

    for (const { key, method } of HTTP_METHODS) {
      const operation = pathItem[key];
      if (!operation) continue;

      const tags =
        Array.isArray(operation.tags) && operation.tags.length > 0
          ? [...operation.tags]
          : ["General"];

      entries.push({
        method,
        path,
        summary: operation.summary ?? operation.description ?? "",
        security: requiresAuth(operation, pathItem, spec),
        tag: tags[0],
        tags,
      });
    }
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Groups build-time OpenAPI routes by primary tag, preserving top-level tag order from `openapi.json`.
 */
export function groupOpenApiRoutesByTag(
  spec: RawOpenApiSpec = openApiSpec as unknown as RawOpenApiSpec,
): OpenApiRouteGroup[] {
  const routes = loadOpenApiRoutes(spec);
  const tagDescriptions = new Map<string, string | undefined>();
  const declaredTagOrder: string[] = [];

  for (const tagDef of spec.tags ?? []) {
    tagDescriptions.set(tagDef.name, tagDef.description);
    declaredTagOrder.push(tagDef.name);
  }

  const byTag = new Map<string, OpenApiRouteEntry[]>();
  for (const route of routes) {
    const bucket = byTag.get(route.tag);
    if (bucket) {
      bucket.push(route);
    } else {
      byTag.set(route.tag, [route]);
    }
  }

  const orderedTags = [
    ...declaredTagOrder.filter((t) => byTag.has(t)),
    ...Array.from(byTag.keys())
      .filter((t) => !declaredTagOrder.includes(t))
      .sort((a, b) => a.localeCompare(b)),
  ];

  return orderedTags.map((tag) => ({
    tag,
    description: tagDescriptions.get(tag),
    routes: byTag.get(tag) ?? [],
  }));
}
