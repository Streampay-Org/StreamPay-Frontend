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
});
