import { normalizeSorobanError } from './mapper';

describe('JSON-safe diagnostic metadata', () => {
  it('serializes bigint and cyclic metadata instead of leaking non-JSON values', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const error = Object.assign(new Error('simulation failed'), {
      variant: 'SimulationFailed', meta: { amount: 123n, cycle },
    });
    const normalized = normalizeSorobanError(error, { environment: 'production' });
    expect(() => JSON.stringify(normalized)).not.toThrow();
    expect(normalized.meta).toEqual({ amount: '123n', cycle: { self: '[Circular]' } });
  });

  it('preserves JSON metadata and existing sensitive-key redaction', () => {
    const error = Object.assign(new Error('simulation failed'), {
      variant: 'SimulationFailed', meta: { count: 2, tags: ['retry'], token: 'private', at: new Date('2026-01-01T00:00:00Z') },
    });
    expect(JSON.parse(JSON.stringify(normalizeSorobanError(error).meta))).toEqual({ count: 2, tags: ['retry'], token: '[REDACTED]', at: '2026-01-01T00:00:00.000Z' });
  });
});
