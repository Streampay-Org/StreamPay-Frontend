import { validateSimulation, SimulationResult } from './simulation-validator';
import { SorobanError, SorobanErrorCode } from '../../types';

describe('validateSimulation', () => {
  const validResult: SimulationResult = {
    results: [{ xdr: 'AAAA' }],
    minResourceFee: '1000',
    cost: { cpuInsns: '100', memBytes: '100' },
  };

  it('passes for a valid simulation result', () => {
    expect(() => validateSimulation(validResult)).not.toThrow();
  });

  it('throws SimulationFailed if payload is missing', () => {
    expect(() => validateSimulation(null)).toThrow(SorobanError);
    try {
      validateSimulation(null);
    } catch (e: any) {
      expect(e.variant).toBe(SorobanErrorCode.SimulationFailed);
      expect(e.message).toMatch(/missing or invalid/);
    }
  });

  it('throws SimulationFailed if simulation has a top-level error', () => {
    const sim = { ...validResult, error: 'Contract panic' };
    expect(() => validateSimulation(sim)).toThrow(SorobanError);
    try {
      validateSimulation(sim);
    } catch (e: any) {
      expect(e.variant).toBe(SorobanErrorCode.SimulationFailed);
      expect(e.message).toMatch(/Contract panic/);
    }
  });

  it('throws SimulationFailed if results array is missing or empty', () => {
    expect(() => validateSimulation({ ...validResult, results: [] })).toThrow(SorobanError);
    expect(() => validateSimulation({ ...validResult, results: undefined })).toThrow(SorobanError);
  });

  it('throws SimulationFailed if result missing xdr', () => {
    expect(() => validateSimulation({ ...validResult, results: [{ xdr: '' }] })).toThrow(SorobanError);
  });

  it('throws SimulationFailed if fee exceeds maxResourceFee', () => {
    const sim = { ...validResult, minResourceFee: '20000000' };
    expect(() => validateSimulation(sim, { maxResourceFee: 10_000_000n })).toThrow(SorobanError);
  });

  it('throws SimulationFailed if CPU exceeds maxCpuInsns', () => {
    const sim = { ...validResult, cost: { cpuInsns: '200000000', memBytes: '100' } };
    expect(() => validateSimulation(sim, { maxCpuInsns: 100_000_000n })).toThrow(SorobanError);
  });

  it('throws SimulationFailed if memory exceeds maxMemBytes', () => {
    const sim = { ...validResult, cost: { cpuInsns: '100', memBytes: '20000000' } };
    expect(() => validateSimulation(sim, { maxMemBytes: 10_000_000n })).toThrow(SorobanError);
  });

  it('throws SimulationFailed if events originate from an unauthorized contract', () => {
    const sim: SimulationResult = {
      ...validResult,
      events: [
        { contractId: 'CONTRACT_A', topics: [], data: { xdr: '' } },
        { contractId: 'CONTRACT_B', topics: [], data: { xdr: '' } },
      ],
    };
    expect(() => validateSimulation(sim, { expectedContractId: 'CONTRACT_A' })).toThrow(SorobanError);
  });

  it('passes if all events originate from the expected contract', () => {
    const sim: SimulationResult = {
      ...validResult,
      events: [
        { contractId: 'CONTRACT_A', topics: [], data: { xdr: '' } },
      ],
    };
    expect(() => validateSimulation(sim, { expectedContractId: 'CONTRACT_A' })).not.toThrow();
  });
});
