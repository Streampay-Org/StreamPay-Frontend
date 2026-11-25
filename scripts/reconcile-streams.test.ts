/** @jest-environment node */

import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerShutdownHandlers,
  run,
  touchWorkerHeartbeat,
} from './reconcile-streams';
import { ReconciliationService } from './reconciliation/reconcile';

let mockRunReconciliation: jest.Mock;

jest.mock('./reconciliation/reconcile', () => ({
  ReconciliationService: jest.fn(),
}));

describe('worker shutdown and heartbeat', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    jest.clearAllMocks();
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'reconcile-worker-'));
    mockRunReconciliation = jest.fn();
    (ReconciliationService as jest.MockedClass<typeof ReconciliationService>).mockImplementation(
      () => ({ runReconciliation: mockRunReconciliation }) as unknown as ReconciliationService,
    );
  });

  afterEach(() => {
    delete process.env.WORKER_HEARTBEAT_FILE;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('creates a heartbeat when its parent directory is missing', () => {
    const heartbeatFile = join(temporaryDirectory, 'missing', 'worker-heartbeat');

    touchWorkerHeartbeat(heartbeatFile);

    expect(existsSync(heartbeatFile)).toBe(true);
  });

  it('marks shutdown on the first signal and forces exit on a second signal', () => {
    const signalSource = new EventEmitter();
    const controller = new AbortController();
    const forceExit = jest.fn();
    const shutdown = registerShutdownHandlers(controller, signalSource, forceExit, jest.fn());

    signalSource.emit('SIGTERM');

    expect(shutdown.isShuttingDown()).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(forceExit).not.toHaveBeenCalled();

    signalSource.emit('SIGTERM');

    expect(forceExit).toHaveBeenCalledWith(143);
    shutdown.dispose();
  });

  it('waits for in-flight work to finish and exits cleanly on shutdown', async () => {
    process.env.WORKER_HEARTBEAT_FILE = join(temporaryDirectory, 'heartbeat', 'worker');
    let finishStep: (() => void) | undefined;
    mockRunReconciliation.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
      const inFlightStep = new Promise<void>((resolve) => {
        finishStep = resolve;
      });
      process.emit('SIGTERM');
      await inFlightStep;
      expect(signal.aborted).toBe(true);
      return {
        timestamp: new Date().toISOString(),
        totalStreamsChecked: 1,
        mismatches: [],
        errors: [{ streamId: 's2', error: 'Reconciliation aborted before this stream was checked.' }],
        status: 'FAILED',
      };
    });

    const result = run();
    let settled = false;
    void result.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishStep?.();
    expect(await result).toBe(0);
  });

  it('keeps real reconciliation failures non-zero and handles rejections', async () => {
    process.env.WORKER_HEARTBEAT_FILE = join(temporaryDirectory, 'heartbeat', 'worker');
    const report = {
      timestamp: new Date().toISOString(),
      totalStreamsChecked: 0,
      mismatches: [],
      errors: [{ streamId: 's1', error: 'RPC failed' }],
      status: 'FAILED',
    };
    mockRunReconciliation.mockResolvedValueOnce(report);
    expect(await run()).toBe(1);

    mockRunReconciliation.mockRejectedValueOnce(new Error('Service rejected'));
    await expect(run()).resolves.toBe(1);
  });
});
