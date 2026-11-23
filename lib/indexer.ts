import { randomUUID } from 'crypto';
import {
  deriveIndexerStatus,
  isStale,
  type IndexerFailure,
  type IndexerStatusState,
  type IndexerTelemetry,
} from './indexerStatus';

export interface IndexerConfig {
  network: string;
  horizonUrl: string;
  overlapWindow: number; // number of ledgers to overlap during backfill or restart
  stallThresholdMs: number;
}

export interface HorizonEvent {
  id: string;
  type: string;
  ledger: number;
  data: any;
  streamId?: string;
}

export interface CursorState {
  lastLedger: number;
  lastUpdatedAt: number;
}

// In-memory persistent mock for cursor state and deduplication
// In production, this would use a durable DB like PostgreSQL or Redis
export const cursorsDb = new Map<string, CursorState>();
export const processedEventsDb = new Set<string>();

export class HorizonIndexer {
  private network: string;
  private horizonUrl: string;
  private overlapWindow: number;
  private stallThresholdMs: number;
  private isRunning: boolean = false;
  /**
   * Latest failure disposition. Reset to "none" whenever a cursor advance
   * succeeds; set to "fatal"/"retrying" on failure so `readStatus()` reports
   * the actionable reason before staleness.
   */
  private failure: IndexerFailure = "none";
  /**
   * This instance's view of the indexer circuit breaker. Kept local so
   * `lib/indexer.ts` does not depend on the app-layer admin guard; the
   * caller (e.g. the status route) feeds it via `setBreakerOpen`.
   */
  private breakerOpen: boolean = false;

  constructor(config: IndexerConfig) {
    this.network = config.network;
    this.horizonUrl = config.horizonUrl;
    this.overlapWindow = config.overlapWindow;
    this.stallThresholdMs = config.stallThresholdMs;
  }

  /**
   * Feed the operator-controlled circuit breaker state into the indexer so
   * `readStatus()` reports the permission/suspended state deterministically.
   */
  public setBreakerOpen(open: boolean) {
    this.breakerOpen = open;
  }

  public async getCursor(): Promise<number> {
    const state = cursorsDb.get(this.network);
    return state ? state.lastLedger : 0;
  }

  public async saveCursor(ledger: number) {
    cursorsDb.set(this.network, { lastLedger: ledger, lastUpdatedAt: Date.now() });
  }

  public checkStall() {
    const state = cursorsDb.get(this.network);
    if (!state) return;
    if (isStale(state.lastUpdatedAt, Date.now(), this.stallThresholdMs)) {
      console.error(`[ALERT] Cursor stalled for network ${this.network}. Last update: ${new Date(state.lastUpdatedAt).toISOString()}`);
    }
  }

  /**
   * Whether the cursor is currently stale (advanced at least once, but not
   * advanced again within the stall threshold while the loop is running).
   * Unlike `checkStall()` this does not log — it is the queryable predicate
   * used to make the stale-state transition explicit and diagnosable.
   */
  public getStale(): boolean {
    const state = cursorsDb.get(this.network);
    if (!state || !this.isRunning) return false;
    return isStale(state.lastUpdatedAt, Date.now(), this.stallThresholdMs);
  }

  /** Latest failure disposition. */
  public getFailure(): IndexerFailure {
    return this.failure;
  }

  /** Whether the indexer main loop is currently running. */
  public getRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Deterministically derive the current indexer status from live telemetry
   * using the pure state machine in `./indexerStatus`. Staleness, permission
   * (breaker), failure/retry, loading, and lag are all resolved in a fixed,
   * documented priority order.
   */
  public readStatus(): IndexerStatusState {
    const state = cursorsDb.get(this.network);
    const telemetry: IndexerTelemetry = {
      running: this.isRunning,
      breakerOpen: this.breakerOpen,
      lastProcessedAt: state ? state.lastUpdatedAt : null,
      now: Date.now(),
      stallThresholdMs: this.stallThresholdMs,
      failure: this.failure,
      lagLedgers: 0,
      syncToleranceLedgers: 2,
    };
    return deriveIndexerStatus(telemetry);
  }

  public async processEvent(event: HorizonEvent, correlationId: string) {
    // Idempotency check using natural keys for each chain event type
    const eventKey = `${this.network}:${event.id}:${event.type}`;
    if (processedEventsDb.has(eventKey)) {
      return; // Deduplicate
    }

    try {
      // Simulate event processing logic here
      processedEventsDb.add(eventKey);
      
      // Persist the cursor after successfully processing
      await this.saveCursor(event.ledger);

      // A successful advance clears any prior failure disposition so the
      // status returns to a healthy (synced/syncing/stalled) lineage.
      this.failure = "none";
    } catch (error) {
      this.failure = "fatal";
      console.error(JSON.stringify({
        level: "error",
        message: "Failed to process event",
        correlation_id: correlationId,
        stream_id: event.streamId,
        event_id: event.id,
        error: error instanceof Error ? error.message : "Unknown error"
      }));
      throw error;
    }
  }

  public async backfill(targetLedger: number, mockEvents: HorizonEvent[] = []) {
    const currentCursor = await this.getCursor();
    // Safe overlap window on re-scan
    const startLedger = Math.max(0, currentCursor - this.overlapWindow);
    
    console.log(`Starting backfill from ledger ${startLedger} to ${targetLedger}`);
    
    const eventsToProcess = mockEvents.filter(e => e.ledger >= startLedger && e.ledger <= targetLedger);
    
    for (const event of eventsToProcess) {
      const correlationId = randomUUID();
      await this.processEvent(event, correlationId);
    }
  }

  public async startMainLoop(pollInterval: number = 5000, fetchEvents?: (ledger: number) => Promise<HorizonEvent[]>) {
    this.isRunning = true;
    while (this.isRunning) {
      try {
        const cursor = await this.getCursor();
        const nextLedger = cursor + 1;
        
        // Mock fetch from Horizon
        const events = fetchEvents ? await fetchEvents(nextLedger) : [];
        for (const event of events) {
          const correlationId = randomUUID();
          await this.processEvent(event, correlationId);
        }
        
        this.checkStall();
      } catch (err) {
        this.failure = "retrying";
        console.error(JSON.stringify({
           level: "error",
           message: "Main loop error",
           correlation_id: randomUUID(),
           error: err instanceof Error ? err.message : String(err)
        }));
      }
      if (!this.isRunning) break;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  public stop() {
    this.isRunning = false;
  }
}
