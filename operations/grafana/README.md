# StreamPay Grafana dashboard

`streampay.json` is a Grafana 10+ dashboard for the metrics exposed by this
frontend at `GET /api/metrics`.

## What it shows

| Panel group | Metrics |
| ----------- | ------- |
| Traffic | `streampay_requests_total`, `streampay_rate_limit_throttled_total` |
| Latency & errors | `http_request_duration_seconds`, `api_streams_request_duration_seconds`, `webhook_request_duration_seconds`, `webhook_requests_total` |
| Surfaces | `api_streams_requests_total`, `export_requests_total`, `api_reconciliation_requests_total`, `wallet_auth_requests_total` |
| Delivery | `webhook_delivery_attempt_duration_seconds` |
| Background jobs | `settle_job_runs_total`, `settle_job_streams_total` |
| Health | `streampay_metrics_up`, `rate_limit_store_unavailable_total` |

Every metric is defined in `src/metrics/registry.ts` or rendered by
`app/api/metrics/route.ts`. `dashboard.test.ts` derives the allowed names from
those files, so a renamed or removed metric breaks the test instead of leaving
a silently empty panel.

## Import

1. In Grafana, open **Dashboards → New → Import**.
2. Upload `operations/grafana/streampay.json`.
3. Pick the Prometheus datasource that scrapes `/api/metrics`.

The dashboard declares a `DS_PROMETHEUS` datasource template, so it can also be
provisioned without editing the JSON:

```yaml
# /etc/grafana/provisioning/dashboards/streampay.yaml
apiVersion: 1
providers:
  - name: StreamPay
    folder: StreamPay
    type: file
    options:
      path: /var/lib/grafana/dashboards/streampay
```

Copy `streampay.json` into that path, or mount this directory read-only.

## Scrape configuration

`/api/metrics` requires a bearer token and is disabled unless
`METRICS_AUTH_TOKEN` is set:

```yaml
scrape_configs:
  - job_name: streampay-frontend
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/streampay-metrics-token
    static_configs:
      - targets: ["streampay.example.com"]
        labels:
          service: streampay-frontend
```

The endpoint returns `503` when the token is not configured and `401`/`403` for
missing or invalid credentials, so alert on `streampay_metrics_up == 0` or
`up{job="streampay-frontend"} == 0` to catch exposure failures.

## Validation

```bash
npm run test -- operations/grafana/dashboard.test.ts
```

The test checks the JSON structure, datasource templating, required panels, and
that every PromQL expression references a real metric (including `_bucket`,
`_sum`, and `_count` derivatives of known histograms).
