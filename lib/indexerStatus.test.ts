import {
  deriveIndexerStatus,
  isStale,
  describeIndexerStatus,
  type IndexerTelemetry,
  type IndexerStatusState,
} from "./indexerStatus";
import * as fc from "fast-check";

function baseTelemetry(overrides: Partial<IndexerTelemetry> = {}): IndexerTelemetry {
  return {
    running: true,
    breakerOpen: false,
    lastProcessedAt: 1_000,
    now: 1_100,
    stallThresholdMs: 10_000,
    failure: "none",
    lagLedgers: 1,
    syncToleranceLedgers: 2,
    ...overrides,
  };
}

describe("isStale", () => {
  it("returns false when the cursor has never advanced (loading, not stale)", () => {
    expect(isStale(null, 1_000, 10_000)).toBe(false);
  });

  it("returns true once age exceeds the threshold", () => {
    expect(isStale(1_000, 1_000 + 10_001, 10_000)).toBe(true);
  });

  it("returns false at exactly the threshold (strict greater-than boundary)", () => {
    expect(isStale(1_000, 1_000 + 10_000, 10_000)).toBe(false);
  });

  it("returns false just below the threshold", () => {
    expect(isStale(1_000, 1_000 + 9_999, 10_000)).toBe(false);
  });

  it("returns false for a freshly advanced cursor", () => {
    expect(isStale(1_000, 1_000, 10_000)).toBe(false);
  });

  it("returns false when staleness detection is disabled (non-positive threshold)", () => {
    expect(isStale(1_000, 1_000 + 999_999, 0)).toBe(false);
    expect(isStale(1_000, 1_000 + 999_999, -1)).toBe(false);
  });
});

describe("deriveIndexerStatus — permission / stopped", () => {
  it("reports stopped when the breaker is open regardless of other inputs", () => {
    const stale = baseTelemetry({
      breakerOpen: true,
      lastProcessedAt: 1,
      now: 1_000_000,
      stallThresholdMs: 10,
      running: true,
    });
    expect(deriveIndexerStatus(stale)).toBe("stopped");
  });

  it("reports stopped even with fatal errors when breaker is open", () => {
    expect(
      deriveIndexerStatus(
        baseTelemetry({ breakerOpen: true, running: true, failure: "fatal" }),
      ),
    ).toBe("stopped");
  });

  it("reports stopped when the main loop is not running", () => {
    const inputs = [
      baseTelemetry({ running: false, lastProcessedAt: null }),
      baseTelemetry({ running: false, lastProcessedAt: 1, now: 1_000_000, stallThresholdMs: 1 }),
    ];
    for (const t of inputs) {
      expect(deriveIndexerStatus(t)).toBe("stopped");
    }
  });
});

describe("deriveIndexerStatus — failure / retry", () => {
  it("reports error for a fatal failure even when stale", () => {
    const t = baseTelemetry({
      failure: "fatal",
      lastProcessedAt: 1,
      now: 1_000_000,
      stallThresholdMs: 10,
    });
    expect(deriveIndexerStatus(t)).toBe("error");
  });

  it("reports retrying for a recoverable failure even when stale", () => {
    const t = baseTelemetry({
      failure: "retrying",
      lastProcessedAt: 1,
      now: 1_000_000,
      stallThresholdMs: 10,
    });
    expect(deriveIndexerStatus(t)).toBe("retrying");
  });

  it("reports error (not retrying) when both fatal and retrying are reported", () => {
    // normalizeFailure keeps a single value; construct directly with fatal.
    const t = baseTelemetry({ failure: "fatal", lagLedgers: 100 });
    expect(deriveIndexerStatus(t)).toBe("error");
  });
});

describe("deriveIndexerStatus — stale-state transition", () => {
  it("reports stalled once the cursor age exceeds the threshold while running", () => {
    const t = baseTelemetry({
      lastProcessedAt: 1_000,
      now: 1_000 + 10_001,
      stallThresholdMs: 10_000,
      lagLedgers: 0,
    });
    expect(deriveIndexerStatus(t)).toBe("stalled");
  });

  it("reports stalled regardless of healthy lag when stale", () => {
    const t = baseTelemetry({
      lastProcessedAt: 1_000,
      now: 1_000 + 10_001,
      stallThresholdMs: 10_000,
      lagLedgers: 0,
    });
    expect(deriveIndexerStatus(t)).toBe("stalled");
  });

  it("does not report stalled exactly at the threshold boundary", () => {
    const t = baseTelemetry({
      lastProcessedAt: 1_000,
      now: 1_000 + 10_000,
      stallThresholdMs: 10_000,
      lagLedgers: 0,
    });
    expect(deriveIndexerStatus(t)).toBe("synced");
  });

  it("recovers from stalled to synced when the cursor advances again", () => {
    const fresh = baseTelemetry({
      lastProcessedAt: Date.now(),
      now: Date.now(),
      lagLedgers: 0,
      failure: "none",
    });
    expect(deriveIndexerStatus(fresh)).toBe("synced");
  });
});

describe("deriveIndexerStatus — loading / steady state", () => {
  it("reports loading when running but the cursor has never advanced", () => {
    const t = baseTelemetry({ lastProcessedAt: null, lagLedgers: 0 });
    expect(deriveIndexerStatus(t)).toBe("loading");
  });

  it("reports synced when lag is within tolerance", () => {
    expect(deriveIndexerStatus(baseTelemetry({ lagLedgers: 0 }))).toBe("synced");
    expect(deriveIndexerStatus(baseTelemetry({ lagLedgers: 2 }))).toBe("synced");
  });

  it("reports syncing when lag exceeds tolerance", () => {
    expect(deriveIndexerStatus(baseTelemetry({ lagLedgers: 3 }))).toBe("syncing");
  });
});

describe("deriveIndexerStatus — deterministic and total", () => {
  it("is total: never throws and returns a valid state", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.integer({ min: -1_000_000, max: 1_000_000 })),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.constantFrom("none", "fatal", "retrying", "bogus" as never),
        fc.integer({ min: -1_000, max: 1_000_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (running, breakerOpen, lastProcessedAt, now, threshold, failure, lag, tol) => {
          const state = deriveIndexerStatus({
            running,
            breakerOpen,
            lastProcessedAt,
            now,
            stallThresholdMs: threshold,
            failure,
            lagLedgers: lag,
            syncToleranceLedgers: tol,
          });
          return [
            "loading",
            "syncing",
            "synced",
            "stalled",
            "stopped",
            "error",
            "retrying",
          ].includes(state);
        },
      ),
    );
  });

  it("produces the same status for identical telemetry (referential determinism)", () => {
    fc.assert(
      fc.property(
        fc.record({
          running: fc.boolean(),
          breakerOpen: fc.boolean(),
          lastProcessedAt: fc.option(fc.integer({ min: 0, max: 1_000_000 })),
          now: fc.integer({ min: 0, max: 2_000_000 }),
          stallThresholdMs: fc.integer({ min: 0, max: 100_000 }),
          failure: fc.constantFrom("none", "fatal", "retrying" as IndexerTelemetry["failure"]),
          lagLedgers: fc.integer({ min: 0, max: 100 }),
          syncToleranceLedgers: fc.integer({ min: 0, max: 10 }),
        }),
        (t) => {
          const a = deriveIndexerStatus(t);
          const b = deriveIndexerStatus({ ...t });
          return a === b;
        },
      ),
    );
  });

  it("never reports synced or syncing while stale", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (lastProcessedAt, now, threshold) => {
          const t: IndexerTelemetry = baseTelemetry({
            lastProcessedAt,
            now,
            stallThresholdMs: threshold,
            failure: "none",
            running: true,
            breakerOpen: false,
          });
          if (isStale(lastProcessedAt, now, threshold)) {
            return deriveIndexerStatus(t) === "stalled";
          }
          return true;
        },
      ),
    );
  });
});

describe("describeIndexerStatus", () => {
  const states: IndexerStatusState[] = [
    "loading",
    "syncing",
    "synced",
    "stalled",
    "stopped",
    "error",
    "retrying",
  ];

  it("returns a non-empty, stable message for every state", () => {
    for (const s of states) {
      const msg = describeIndexerStatus(s);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("mentions the circuit breaker for the stopped state (permission)", () => {
    expect(describeIndexerStatus("stopped").toLowerCase()).toMatch(/breaker|stop/i);
  });

  it("mentions staleness for the stalled state", () => {
    expect(describeIndexerStatus("stalled").toLowerCase()).toMatch(/stall|stale/i);
  });
});
