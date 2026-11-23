/** @jest-environment node */

/**
 * Test plan rows 1–2: the instrumentation hook must only load the tracer for
 * the Node.js runtime.
 */

jest.mock('./lib/otel', () => {
  const target = globalThis as typeof globalThis & { __otelLoads?: number };
  target.__otelLoads = (target.__otelLoads ?? 0) + 1;
  return {};
});

describe('instrumentation register()', () => {
  let register: () => Promise<void>;
  const originalRuntime = process.env.NEXT_RUNTIME;

  const loadCount = (): number | undefined =>
    (globalThis as typeof globalThis & { __otelLoads?: number }).__otelLoads;

  beforeEach(async () => {
    delete (globalThis as typeof globalThis & { __otelLoads?: number })
      .__otelLoads;
    jest.resetModules();
    ({ register } = await import('./instrumentation'));
  });

  afterAll(() => {
    if (originalRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalRuntime;
    }
  });

  it('loads the tracer module for the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    await register();

    expect(loadCount()).toBe(1);
  });

  it('does not load the tracer module for the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    await register();

    expect(loadCount()).toBeUndefined();
  });
});
