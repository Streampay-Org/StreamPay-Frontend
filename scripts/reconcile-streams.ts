import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReconciliationService } from './reconciliation/reconcile';
import { ReconciliationReport } from './reconciliation/types';

export const DEFAULT_WORKER_HEARTBEAT_FILE = '/tmp/worker-heartbeat';

type TerminationSignal = 'SIGINT' | 'SIGTERM';

interface SignalSource {
  on(signal: TerminationSignal, listener: () => void): unknown;
  removeListener(signal: TerminationSignal, listener: () => void): unknown;
}

export function touchWorkerHeartbeat(file = DEFAULT_WORKER_HEARTBEAT_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${Date.now()}\n`, 'utf8');
}

export function registerShutdownHandlers(
  controller: AbortController,
  signalSource: SignalSource = process,
  forceExit: (code: number) => void = (code) => process.exit(code),
  log: (message: string) => void = (message) => console.log(message),
) {
  let shuttingDown = false;

  const handleSignal = (signal: TerminationSignal) => {
    if (shuttingDown) {
      log(`Received ${signal} again; forcing immediate exit.`);
      forceExit(signal === 'SIGINT' ? 130 : 143);
      return;
    }

    shuttingDown = true;
    log(`Received ${signal}; draining after the current reconciliation step.`);
    controller.abort();
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');

  signalSource.on('SIGINT', handleSigint);
  signalSource.on('SIGTERM', handleSigterm);

  return {
    isShuttingDown: () => shuttingDown,
    dispose: () => {
      signalSource.removeListener('SIGINT', handleSigint);
      signalSource.removeListener('SIGTERM', handleSigterm);
    },
  };
}

export async function run(): Promise<number> {
  const controller = new AbortController();
  const shutdown = registerShutdownHandlers(controller);
  const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || DEFAULT_WORKER_HEARTBEAT_FILE;

  try {
    touchWorkerHeartbeat(heartbeatFile);
    console.log('Starting Nightly Reconciliation Job...');

    const service = new ReconciliationService({
      tolerance: BigInt(process.env.RECONCILE_TOLERANCE || '0'),
    });
    const report = await service.runReconciliation({
      signal: controller.signal,
      onProgress: () => touchWorkerHeartbeat(heartbeatFile),
    });

    console.log('Reconciliation Finished.');
    console.log(`Total Checked: ${report.totalStreamsChecked}`);
    console.log(`Mismatches: ${report.mismatches.length}`);
    console.log(`Errors: ${report.errors.length}`);
    console.log(`Status: ${report.status}`);

    const stoppedForShutdown =
      shutdown.isShuttingDown() &&
      report.status === 'FAILED' &&
      report.errors.length > 0 &&
      report.errors.every(({ error }) =>
        error === 'Reconciliation aborted before this stream was checked.' ||
        error === 'Reconciliation aborted before completion.',
      );

    if (shutdown.isShuttingDown()) {
      console.log('Reconciliation drained after shutdown signal.');
    }

    if (report.status !== 'SUCCESS' && !stoppedForShutdown) {
      await sendAlert(report);
    }

    if (report.status === 'FAILED' && !stoppedForShutdown) {
      return 1;
    }
    return 0;
  } catch (err) {
    console.error('Critical error during reconciliation:', err);
    return 1;
  } finally {
    shutdown.dispose();
  }
}

async function sendAlert(report: ReconciliationReport) {
  // Mock alerting (Slack/PagerDuty)
  console.log("-----------------------------------------");
  console.log("[ALERT] Reconciliation Mismatch Detected!");
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Mismatches: ${report.mismatches.length}`);

  report.mismatches.forEach(m => {
    console.log(`- Stream ${m.streamId}: Field ${m.field} (DB: ${m.dbValue} vs Chain: ${m.onChainValue})`);
  });

  if (report.errors.length > 0) {
    console.log(`Errors: ${report.errors.length}`);
    report.errors.forEach(e => {
      console.log(`- Stream ${e.streamId}: ${e.error}`);
    });
  }
  console.log("-----------------------------------------");
}

if (require.main === module) {
  void run().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((err) => {
    console.error('Critical error during reconciliation:', err);
    process.exitCode = 1;
  });
}
