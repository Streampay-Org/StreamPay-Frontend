describe('src/metrics/registry', () => {
  it('imports the registry twice via jest.isolateModules without throwing and returns the same counter instance', () => {
    let mod1!: typeof import('./registry');
    let mod2!: typeof import('./registry');

    expect(() => {
      jest.isolateModules(() => {
        mod1 = require('./registry');
      });
      jest.isolateModules(() => {
        mod2 = require('./registry');
      });
    }).not.toThrow();

    expect(mod1).toBeDefined();
    expect(mod2).toBeDefined();

    // Registry instance is preserved across re-imports on globalThis
    expect(mod1.registry).toBe(mod2.registry);

    // Metric instances are reused across hot reloads / re-imports
    expect(mod1.walletAuthCounter).toBe(mod2.walletAuthCounter);
    expect(mod1.walletAuthDuration).toBe(mod2.walletAuthDuration);
    expect(mod1.webhookCounter).toBe(mod2.webhookCounter);
    expect(mod1.webhookDuration).toBe(mod2.webhookDuration);
    expect(mod1.exportCounter).toBe(mod2.exportCounter);
    expect(mod1.exportDuration).toBe(mod2.exportDuration);
    expect(mod1.reconciliationCounter).toBe(mod2.reconciliationCounter);
    expect(mod1.reconciliationDuration).toBe(mod2.reconciliationDuration);
    expect(mod1.streamsCounter).toBe(mod2.streamsCounter);
    expect(mod1.streamsDuration).toBe(mod2.streamsDuration);
    expect(mod1.httpRequestDuration).toBe(mod2.httpRequestDuration);
  });

  describe('getOrCreateCounter', () => {
    it('creates a counter on first call and reuses existing instance on subsequent calls', () => {
      const { registry, getOrCreateCounter } = require('./registry');
      const counterName = 'test_idempotent_counter_total';

      const counter1 = getOrCreateCounter(counterName, {
        help: 'Test counter for idempotency',
        labelNames: ['test_label'],
      });
      expect(counter1).toBeDefined();
      expect(registry.getSingleMetric(counterName)).toBe(counter1);

      const counter2 = getOrCreateCounter(counterName, {
        help: 'Test counter for idempotency with different help',
        labelNames: ['test_label'],
      });
      expect(counter2).toBe(counter1);
    });
  });

  describe('getOrCreateHistogram', () => {
    it('creates a histogram on first call and reuses existing instance on subsequent calls', () => {
      const { registry, getOrCreateHistogram } = require('./registry');
      const histName = 'test_idempotent_histogram_seconds';

      const hist1 = getOrCreateHistogram(histName, {
        help: 'Test histogram for idempotency',
        labelNames: ['test_label'],
        buckets: [0.1, 0.5, 1],
      });
      expect(hist1).toBeDefined();
      expect(registry.getSingleMetric(histName)).toBe(hist1);

      const hist2 = getOrCreateHistogram(histName, {
        help: 'Test histogram for idempotency with different help',
        labelNames: ['test_label'],
        buckets: [0.1, 0.5, 1],
      });
      expect(hist2).toBe(hist1);
    });
  });

  describe('observeStreamsRequest', () => {
    it('increments streamsCounter and observes streamsDuration', async () => {
      const { registry, observeStreamsRequest } = require('./registry');
      const start = process.hrtime();
      observeStreamsRequest('POST', 201, start);

      const metrics = await registry.metrics();
      expect(metrics).toContain('api_streams_requests_total{method="POST",status="201"}');
      expect(metrics).toContain('api_streams_request_duration_seconds');
    });
  });

  describe('normalizeRoute', () => {
    it('keeps known static routes unchanged and strips query strings / trailing slashes', () => {
      const { normalizeRoute } = require('./registry');
      expect(normalizeRoute('/api/streams')).toBe('/api/streams');
      expect(normalizeRoute('/api/streams?limit=10&cursor=abc')).toBe('/api/streams');
      expect(normalizeRoute('/api/streams/')).toBe('/api/streams');
      expect(normalizeRoute('/api/streams/health')).toBe('/api/streams/health');
      expect(normalizeRoute('/api/metrics')).toBe('/api/metrics');
    });

    it('collapses dynamic IDs, UUIDs, hashes, and Next.js route templates to :id', () => {
      const { normalizeRoute } = require('./registry');
      expect(normalizeRoute('/api/streams/abc123')).toBe('/api/streams/:id');
      expect(normalizeRoute('/api/streams/550e8400-e29b-41d4-a716-446655440000/pause')).toBe(
        '/api/streams/:id/pause',
      );
      expect(normalizeRoute('/api/streams/[id]')).toBe('/api/streams/:id');
      expect(normalizeRoute('/api/orgs/[orgId]/members')).toBe('/api/orgs/:id/members');
      expect(normalizeRoute('/api/orgs/org_9f8e7d6c/policy?draft=1')).toBe('/api/orgs/:id/policy');
      expect(normalizeRoute('/api/exports/job-abc-123')).toBe('/api/exports/:id');
      expect(normalizeRoute('/api/streams/123/approvals/456/approve')).toBe(
        '/api/streams/:id/approvals/:id/approve',
      );
    });

    it('groups unknown or malformed paths as unmatched to bound cardinality', () => {
      const { normalizeRoute } = require('./registry');
      expect(normalizeRoute('/api/nonexistent/route')).toBe('unmatched');
      expect(normalizeRoute('/wp-admin/install.php')).toBe('unmatched');
      expect(normalizeRoute('')).toBe('unmatched');
      expect(normalizeRoute('relative/path')).toBe('unmatched');
    });
  });

  describe('observeHttpRequest', () => {
    it('records bucket counts and labels in registry.metrics() including 304, HEAD/OPTIONS, and 0ms', async () => {
      const { registry, httpRequestDuration, observeHttpRequest } = require('./registry');
      httpRequestDuration.reset();

      observeHttpRequest('GET', '/api/streams/abc123', 200, 0.042);
      observeHttpRequest('GET', '/api/streams/xyz789', 304, 0);
      observeHttpRequest('HEAD', '/api/healthz', 200, 0.001);
      observeHttpRequest('OPTIONS', '/api/exports', 204, 0.002);
      observeHttpRequest('POST', '/api/unknown/path', 404, 0.15);
      observeHttpRequest('DELETE', '/api/streams/550e8400-e29b-41d4-a716-446655440000', 503, 1.2);

      const metrics = await registry.metrics();

      expect(metrics).toContain('# TYPE http_request_duration_seconds histogram');
      expect(metrics).toContain(
        'http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/streams/:id",status_class="2xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_count{method="GET",route="/api/streams/:id",status_class="2xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_bucket{le="0.005",method="GET",route="/api/streams/:id",status_class="3xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_count{method="HEAD",route="/api/healthz",status_class="2xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_count{method="OPTIONS",route="/api/exports",status_class="2xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_count{method="POST",route="unmatched",status_class="4xx"} 1',
      );
      expect(metrics).toContain(
        'http_request_duration_seconds_count{method="DELETE",route="/api/streams/:id",status_class="5xx"} 1',
      );
      // Raw IDs must never appear as route labels
      expect(metrics).not.toContain('abc123');
      expect(metrics).not.toContain('xyz789');
    });
  });
});
