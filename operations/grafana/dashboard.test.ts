import fs from "node:fs";
import path from "node:path";

type Panel = {
  id: number;
  title: string;
  type: string;
  datasource?: { type?: string; uid?: string };
  targets?: Array<{ expr?: string; datasource?: { uid?: string } }>;
  panels?: Panel[];
};

type Dashboard = {
  title: string;
  uid: string;
  schemaVersion: number;
  tags: string[];
  panels: Panel[];
  templating: {
    list: Array<{ name: string; type: string; label?: string }>;
  };
};

const root = path.join(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

const dashboard = JSON.parse(
  fs.readFileSync(path.join(__dirname, "streampay.json"), "utf8"),
) as Dashboard;

/**
 * Metric names are derived from the code that defines them rather than being
 * copied by hand, so a renamed metric fails this test instead of silently
 * breaking the dashboard.
 *
 * Sources:
 *  - `src/metrics/registry.ts` — prom-client counters/histograms.
 *  - `app/api/metrics/route.ts` — hand-rendered counters/gauges.
 */
function metricNamesDefinedInCode(): Set<string> {
  const names = new Set<string>();

  for (const match of read("src/metrics/registry.ts").matchAll(
    /getOrCreate(?:Counter|Histogram)\(\s*["']([^"']+)["']/g,
  )) {
    names.add(match[1]);
  }

  for (const match of read("app/api/metrics/route.ts").matchAll(
    /# (?:HELP|TYPE) (streampay_[a-z0-9_:]+)/g,
  )) {
    names.add(match[1]);
  }

  return names;
}

function flattenPanels(panels: Panel[]): Panel[] {
  return panels.flatMap((panel) => [
    panel,
    ...(panel.panels ? flattenPanels(panel.panels) : []),
  ]);
}

/** Identifiers in a PromQL expression that look like metric samples. */
function metricTokens(expr: string): string[] {
  return (expr.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? []).filter((token) =>
    /_(?:total|seconds|up|bucket|sum|count)$/.test(token),
  );
}

const knownMetrics = metricNamesDefinedInCode();
const panels = flattenPanels(dashboard.panels);

describe("StreamPay Grafana dashboard", () => {
  it("identifies the dashboard and exposes a Prometheus datasource variable", () => {
    expect(dashboard.title).toBe("StreamPay Frontend");
    expect(dashboard.uid).toBe("streampay-frontend");
    expect(dashboard.tags).toEqual(expect.arrayContaining(["streampay"]));
    expect(dashboard.schemaVersion).toBeLessThanOrEqual(39);

    expect(dashboard.templating.list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "DS_PROMETHEUS", type: "datasource" }),
      ]),
    );
  });

  it("reads the metrics the code actually defines", () => {
    expect(knownMetrics.size).toBeGreaterThanOrEqual(15);
    expect(knownMetrics).toContain("api_streams_requests_total");
    expect(knownMetrics).toContain("webhook_requests_total");
    expect(knownMetrics).toContain("streampay_metrics_up");
  });

  it("uses the datasource template for every panel and target", () => {
    expect(panels.length).toBeGreaterThanOrEqual(10);

    const panelIds = panels.map((panel) => panel.id);
    expect(new Set(panelIds).size).toBe(panelIds.length);

    for (const panel of panels) {
      expect(panel.title).toBeTruthy();
      expect(panel.datasource).toEqual({
        type: "prometheus",
        uid: "${DS_PROMETHEUS}",
      });
      expect(panel.targets?.length).toBeGreaterThan(0);

      for (const target of panel.targets ?? []) {
        expect(target.expr).toBeTruthy();
        expect(target.datasource).toEqual({
          type: "prometheus",
          uid: "${DS_PROMETHEUS}",
        });
      }
    }
  });

  it("only references metrics that exist in the registry or metrics route", () => {
    const unknown = new Set<string>();

    for (const panel of panels) {
      for (const target of panel.targets ?? []) {
        for (const token of metricTokens(target.expr ?? "")) {
          const base = token.replace(/_(?:bucket|sum|count)$/, "");
          if (!knownMetrics.has(token) && !knownMetrics.has(base)) {
            unknown.add(token);
          }
        }
      }
    }

    expect([...unknown]).toEqual([]);
  });

  it("covers the core request, latency, and webhook signals", () => {
    const titles = panels.map((panel) => panel.title).join("\n");

    for (const required of [
      /request rate/i,
      /throttle/i,
      /p95 latency/i,
      /5xx/i,
      /webhook/i,
      /settle/i,
      /metrics endpoint up/i,
    ]) {
      expect(titles).toMatch(required);
    }

    const panicMetrics = panels
      .flatMap((panel) => panel.targets ?? [])
      .map((target) => target.expr ?? "")
      .join("\n");
    expect(panicMetrics).toContain("api_streams_request_duration_seconds_bucket");
    expect(panicMetrics).toContain("webhook_delivery_attempt_duration_seconds_count");
  });

  it("matches webhook failures by HTTP status rather than a 'failed' label", () => {
    const webhookErrorPanel = panels.find((panel) =>
      /webhook 5xx/i.test(panel.title),
    );

    expect(webhookErrorPanel).toBeDefined();
    const expr = webhookErrorPanel?.targets?.[0]?.expr ?? "";

    expect(expr).toContain('status=~"5.."');
    expect(expr).not.toContain('status="failed"');
  });
});
