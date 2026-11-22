import React from "react";
import { render, screen, within } from "@testing-library/react";
import openApiSpec from "../../openapi.json";
import DocsPage from "./page";
import { groupOpenApiRoutesByTag, loadOpenApiRoutes } from "./openapi-routes";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

describe("app/docs OpenAPI reference", () => {
  it("loader returns every spec path and method sorted by path (count equals the spec)", () => {
    const routes = loadOpenApiRoutes();

    let expectedCount = 0;
    const expectedPairs = new Set<string>();
    for (const [pathKey, pathItem] of Object.entries(openApiSpec.paths)) {
      const record = pathItem as Record<string, unknown>;
      for (const method of HTTP_METHODS) {
        if (record[method]) {
          expectedCount += 1;
          expectedPairs.add(`${method.toUpperCase()} ${pathKey}`);
        }
      }
    }

    expect(routes).toHaveLength(expectedCount);

    for (const route of routes) {
      expect(expectedPairs.has(`${route.method} ${route.path}`)).toBe(true);
    }

    const paths = routes.map((r) => r.path);
    const sortedPaths = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sortedPaths);
  });

  it("groups routes by tag without dropping any operation", () => {
    const routes = loadOpenApiRoutes();
    const groups = groupOpenApiRoutesByTag();

    const flattened = groups.flatMap((group) => group.routes);
    expect(flattened).toHaveLength(routes.length);
    expect(groups.map((g) => g.tag)).toEqual(
      expect.arrayContaining(["Activity", "Auth", "Notifications", "Streams", "System"]),
    );
  });

  it("renders /docs with /api/activity and /api/notifications/preferences grouped by tag", () => {
    render(<DocsPage />);

    expect(screen.getByText("/api/activity")).toBeInTheDocument();
    expect(screen.getAllByText("/api/notifications/preferences").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("region", { name: "Activity API routes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Notifications API routes" })).toBeInTheDocument();
  });

  it("renders a lock icon plus 'Requires auth' for secured routes and 'Public' for open routes", () => {
    const { container } = render(<DocsPage />);

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const securedRow = rows.find((row) =>
      row.textContent?.includes("PUT") && row.textContent?.includes("/api/notifications/preferences"),
    );
    expect(securedRow).toBeDefined();

    const securedBadge = securedRow!.querySelector(".docs__auth-badge");
    expect(securedBadge).not.toBeNull();
    expect(within(securedRow as HTMLElement).getByText("Requires auth")).toBeInTheDocument();
    expect(securedBadge!.querySelector("svg.docs__auth-icon")).not.toBeNull();

    const publicRow = rows.find((row) =>
      row.textContent?.includes("GET") && row.textContent?.includes("/api/healthz"),
    );
    expect(publicRow).toBeDefined();
    expect(within(publicRow as HTMLElement).getByText("Public")).toBeInTheDocument();
    expect(publicRow!.querySelector("svg.docs__auth-icon")).toBeNull();
  });
});
