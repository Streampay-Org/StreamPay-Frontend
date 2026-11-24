import { SorobanError, SorobanErrorCode } from "../../types";

export interface SimulationResult {
  error?: string;
  results?: Array<{ xdr: string; auth?: string[] }>;
  cost?: {
    cpuInsns: string;
    memBytes: string;
  };
  minResourceFee?: string;
  events?: Array<{ contractId: string; topics: string[]; data: { xdr: string } }>;
  transactionData?: string;
}

export interface ValidationOptions {
  maxResourceFee?: bigint;
  maxCpuInsns?: bigint;
  maxMemBytes?: bigint;
  expectedContractId?: string;
}

/**
 * Validates a Soroban transaction simulation result to ensure it is deterministic,
 * safe, and within resource limits before signing and submission.
 *
 * @param simulation The parsed response from a Soroban RPC simulateTransaction call.
 * @param options Configurable bounds and expected footprint/contract constraints.
 */
export function validateSimulation(
  simulation: SimulationResult | null | undefined,
  options?: ValidationOptions
): void {
  if (!simulation) {
    throw new SorobanError(
      SorobanErrorCode.SimulationFailed,
      "Simulation payload is missing or invalid",
      { statusCode: 400 }
    );
  }

  // 1. Check for top-level errors (e.g. contract panic, revert)
  if (simulation.error) {
    throw new SorobanError(
      SorobanErrorCode.SimulationFailed,
      `Transaction simulation failed: ${simulation.error}`,
      { statusCode: 400, meta: { simulationError: simulation.error } }
    );
  }

  // 2. Check for missing or empty results
  if (!simulation.results || simulation.results.length === 0) {
    throw new SorobanError(
      SorobanErrorCode.SimulationFailed,
      "Simulation did not return any results. The transaction may be invalid.",
      { statusCode: 400 }
    );
  }

  const result = simulation.results[0];
  if (!result.xdr) {
    throw new SorobanError(
      SorobanErrorCode.SimulationFailed,
      "Simulation result is missing XDR data.",
      { statusCode: 400 }
    );
  }

  // 3. Validate resource consumption (Abuse Resistance)
  const defaultMaxFee = 10_000_000n; // 1 XLM default max fee
  const maxFee = options?.maxResourceFee ?? defaultMaxFee;
  if (simulation.minResourceFee) {
    const fee = BigInt(simulation.minResourceFee);
    if (fee > maxFee) {
      throw new SorobanError(
        SorobanErrorCode.SimulationFailed,
        `Simulation fee ${fee.toString()} exceeds maximum allowed fee ${maxFee.toString()}`,
        { statusCode: 400, meta: { fee: fee.toString(), maxFee: maxFee.toString() } }
      );
    }
  }

  const maxCpu = options?.maxCpuInsns ?? 100_000_000n; // arbitrary safe default
  const maxMem = options?.maxMemBytes ?? 10_000_000n; // arbitrary safe default
  if (simulation.cost) {
    const cpu = BigInt(simulation.cost.cpuInsns || "0");
    const mem = BigInt(simulation.cost.memBytes || "0");
    if (cpu > maxCpu) {
      throw new SorobanError(
        SorobanErrorCode.SimulationFailed,
        `Simulation CPU cost ${cpu.toString()} exceeds maximum allowed ${maxCpu.toString()}`,
        { statusCode: 400, meta: { cpu: cpu.toString(), maxCpu: maxCpu.toString() } }
      );
    }
    if (mem > maxMem) {
      throw new SorobanError(
        SorobanErrorCode.SimulationFailed,
        `Simulation memory cost ${mem.toString()} exceeds maximum allowed ${maxMem.toString()}`,
        { statusCode: 400, meta: { mem: mem.toString(), maxMem: maxMem.toString() } }
      );
    }
  }

  // 4. Validate footprint / expected contract (Least Privilege)
  if (options?.expectedContractId && simulation.events) {
    for (const event of simulation.events) {
      if (event.contractId !== options.expectedContractId) {
        throw new SorobanError(
          SorobanErrorCode.SimulationFailed,
          `Unauthorized contract mutation detected. Expected ${options.expectedContractId}, found ${event.contractId}`,
          { statusCode: 400, meta: { expected: options.expectedContractId, found: event.contractId } }
        );
      }
    }
  }
}
