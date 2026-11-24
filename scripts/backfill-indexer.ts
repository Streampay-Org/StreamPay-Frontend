import { HorizonIndexer } from '../lib/indexer';

export async function runBackfill(): Promise<number> {
  const targetLedger = parseInt(process.env.TARGET_LEDGER || '0', 10);
  
  if (!targetLedger || targetLedger <= 0) {
    console.error('Error: TARGET_LEDGER environment variable is required and must be > 0.');
    return 1;
  }

  console.log(`Initializing indexer backfill for target ledger: ${targetLedger}`);

  const indexer = new HorizonIndexer({
    network: process.env.NETWORK || 'public',
    horizonUrl: process.env.HORIZON_URL || 'https://horizon.stellar.org',
    overlapWindow: parseInt(process.env.OVERLAP_WINDOW || '100', 10),
    stallThresholdMs: 300000, // 5 minutes
  });

  try {
    // In a real environment, you'd fetch real historical events from your Horizon RPC
    // Here we pass an empty array to simulate the call signature for this job template
    await indexer.backfill(targetLedger, []);
    console.log('Backfill completed successfully.');
    return 0;
  } catch (err) {
    console.error('Backfill job failed:', err);
    return 1;
  }
}

if (require.main === module) {
  runBackfill().then((code) => {
    process.exit(code);
  });
}
