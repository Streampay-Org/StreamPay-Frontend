import { HorizonIndexer, HorizonEvent, cursorsDb, processedEventsDb } from './indexer';

function installFakeNow(now: number) {
  jest.spyOn(Date, 'now').mockReturnValue(now);
}

describe('HorizonIndexer', () => {
  let indexer: HorizonIndexer;

  beforeEach(() => {
    cursorsDb.clear();
    processedEventsDb.clear();
    
    indexer = new HorizonIndexer({
      network: 'testnet',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      overlapWindow: 5,
      stallThresholdMs: 1000,
    });
  });

  afterEach(() => {
    indexer.stop();
    jest.restoreAllMocks();
  });

  it('should persist last_ledger cursor', async () => {
    await indexer.saveCursor(100);
    const cursor = await indexer.getCursor();
    expect(cursor).toBe(100);
  });

  it('should deduplicate events idempotently', async () => {
    const event: HorizonEvent = {
      id: 'evt_1',
      type: 'payment',
      ledger: 101,
      data: { amount: '10' }
    };

    await indexer.processEvent(event, 'corr-1');
    expect(processedEventsDb.size).toBe(1);
    
    // Process same event again
    await indexer.processEvent(event, 'corr-2');
    // Size should still be 1
    expect(processedEventsDb.size).toBe(1);
    
    const cursor = await indexer.getCursor();
    expect(cursor).toBe(101);
  });

  it('should support backfill with a safe overlap window', async () => {
    await indexer.saveCursor(100);
    
    const mockEvents: HorizonEvent[] = [
      { id: 'evt_94', type: 'payment', ledger: 94, data: {} }, // Before overlap (should be skipped)
      { id: 'evt_95', type: 'payment', ledger: 95, data: {} }, // Start of overlap
      { id: 'evt_100', type: 'payment', ledger: 100, data: {} }, // Overlap event
      { id: 'evt_102', type: 'payment', ledger: 102, data: {} }, // New event
    ];

    await indexer.backfill(105, mockEvents);

    // Should only process events from ledger 95 to 105
    expect(processedEventsDb.has('testnet:evt_94:payment')).toBe(false);
    expect(processedEventsDb.has('testnet:evt_95:payment')).toBe(true);
    expect(processedEventsDb.has('testnet:evt_100:payment')).toBe(true);
    expect(processedEventsDb.has('testnet:evt_102:payment')).toBe(true);
    
    const cursor = await indexer.getCursor();
    expect(cursor).toBe(102); // The last processed event ledger
  });

  it('should handle drop/restart mid-stream via backfill', async () => {
    const mockEvents: HorizonEvent[] = [
      { id: 'evt_1', type: 'payment', ledger: 1, data: {} },
      { id: 'evt_2', type: 'payment', ledger: 2, data: {} },
      { id: 'evt_3', type: 'payment', ledger: 3, data: {} },
      { id: 'evt_4', type: 'payment', ledger: 4, data: {} },
    ];

    // Simulating dropping mid-stream at ledger 2
    await indexer.saveCursor(2);
    // Processed 1 and 2
    await indexer.processEvent(mockEvents[0], 'corr-drop');
    await indexer.processEvent(mockEvents[1], 'corr-drop');

    // Restart and backfill up to ledger 4
    await indexer.backfill(4, mockEvents);

    // Overlap window is 5, so it should re-process from max(0, 2 - 5) = 0
    // Because of deduplication, events 1 and 2 shouldn't be re-added or fail
    expect(processedEventsDb.size).toBe(4);
    expect(await indexer.getCursor()).toBe(4);
  });

  it('should alert if cursor stalls', () => {
    jest.useFakeTimers();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    void indexer.saveCursor(100);
    
    // Advance time past stallThresholdMs (1000ms)
    jest.advanceTimersByTime(1500);
    
    indexer.checkStall();
    
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ALERT] Cursor stalled for network testnet'));
    
    consoleSpy.mockRestore();
    jest.useRealTimers();
  });
  
  it('should log structured errors', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    const event: HorizonEvent = {
      id: 'bad_evt',
      type: 'payment',
      ledger: 105,
      data: {},
      streamId: 'stream_1'
    };
    
    // Inject a bug/failure intentionally
    const errorIndexer = new HorizonIndexer({
      network: 'testnet',
      horizonUrl: 'test',
      overlapWindow: 5,
      stallThresholdMs: 1000,
    });
    
    // Override saveCursor to throw
    errorIndexer.saveCursor = jest.fn().mockRejectedValue(new Error('DB connection failed'));
    
    await expect(errorIndexer.processEvent(event, 'corr-123')).rejects.toThrow('DB connection failed');
    
    expect(consoleSpy).toHaveBeenCalled();
    const logCall = consoleSpy.mock.calls[0][0];
    const parsedLog = JSON.parse(logCall);
    
    expect(parsedLog.level).toBe('error');
    expect(parsedLog.correlation_id).toBe('corr-123');
    expect(parsedLog.stream_id).toBe('stream_1');
    expect(parsedLog.error).toBe('DB connection failed');
    
    consoleSpy.mockRestore();
  });

  describe('readStatus / deterministic stale-state transitions', () => {
    it('reports stopped when the main loop is not running', () => {
      indexer.stop();
      expect(indexer.getRunning()).toBe(false);
      expect(indexer.readStatus()).toBe('stopped');
    });

    it('reports stopped when the breaker is open (permission)', () => {
      installFakeNow(1_000);
      indexer.setBreakerOpen(true);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      expect(indexer.readStatus()).toBe('stopped');
      expect(indexer.getStale()).toBe(false);
    });

    it('reports loading when running but the cursor has never advanced', () => {
      installFakeNow(1_000);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      expect(indexer.readStatus()).toBe('loading');
    });

    it('reports synced after a cursor advance clears loading', async () => {
      installFakeNow(1_000);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      await indexer.saveCursor(5);
      expect(indexer.readStatus()).toBe('synced');
      expect(indexer.getFailure()).toBe('none');
    });

    it('transitions to stalled once the cursor goes stale while running', () => {
      installFakeNow(1_000);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      cursorsDb.set('testnet', { lastLedger: 5, lastUpdatedAt: 1_000 });

      // Exactly at the 1000ms threshold: fresh (strict greater-than).
      installFakeNow(2_000);
      expect(indexer.readStatus()).toBe('synced');
      expect(indexer.getStale()).toBe(false);

      // Just past the threshold: stale.
      installFakeNow(2_001);
      expect(indexer.getStale()).toBe(true);
      expect(indexer.readStatus()).toBe('stalled');
    });

    it('recovers from stalled to synced when the cursor advances again', async () => {
      installFakeNow(1_000);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);

      // Stale: now(1000) - lastUpdatedAt(-1) = 1001 > threshold(1000).
      cursorsDb.set('testnet', { lastLedger: 5, lastUpdatedAt: -1 });
      expect(indexer.readStatus()).toBe('stalled');

      // Advance cursor at now -> fresh again.
      installFakeNow(2_000);
      await indexer.saveCursor(6);
      expect(indexer.getStale()).toBe(false);
      expect(indexer.readStatus()).toBe('synced');
    });

    it('reports error and then recovers after a successful advance', async () => {
      installFakeNow(1_000);
      void indexer.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const event: HorizonEvent = {
        id: 'fatal_evt',
        type: 'payment',
        ledger: 7,
        data: {},
      };
      const broken = new HorizonIndexer({
        network: 'testnet',
        horizonUrl: 'test',
        overlapWindow: 5,
        stallThresholdMs: 1000,
      });
      broken.setBreakerOpen(false);
      void broken.startMainLoop(60_000, async () => [] as HorizonEvent[]);
      broken.saveCursor = jest.fn().mockRejectedValue(new Error('DB down'));
      await expect(broken.processEvent(event, 'corr-fatal')).rejects.toThrow('DB down');
      expect(broken.getFailure()).toBe('fatal');
      expect(broken.readStatus()).toBe('error');
      broken.stop();

      // Recover on the original fresh indexer.
      await indexer.saveCursor(7);
      expect(indexer.getFailure()).toBe('none');
      expect(indexer.readStatus()).toBe('synced');
      consoleErrorSpy.mockRestore();
    });
  });
});
