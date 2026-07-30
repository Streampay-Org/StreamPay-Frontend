/**
 * Tests for `lib/sorobanRetryQueue.ts`.
 *
 * Coverage targets the satisfaction of issue #913 acceptance criteria:
 * - enqueue / dequeue success
 * - retry scheduling with exponential backoff
 * - retry exhaustion → dead letter
 * - retry persistence across operations
 * - invalid payload rejection
 * - malformed input rejection
 * - standardised error envelopes
 * - structured logging behaviour
 * - correlation ID propagation
 * - edge cases & failure recovery
 *
 * Tests reset the queue in `beforeEach` so module-level state cannot
 * leak between specs.
 */

import {
  sorobanRetryQueue,
  computeBackoff,
  DEFAULT_RETRY_QUEUE_CONFIG,
  type RetryQueueEntry,
  type RetryQueueResult,
  type SorobanOperation,
} from "./sorobanRetryQueue";
import { SorobanError, SorobanErrorCode } from "../types";

// ──────── Helpers ────────────────────────────────────────────────────────────

/** Silence console output but capture it for assertions. */
function captureLogs() {
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  return {
    logCalls: logSpy.mock.calls,
    warnCalls: warnSpy.mock.calls,
    errorCalls: errorSpy.mock.calls,
    restore: () => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

/** Parse captured log calls as JSON objects, filtered by message. */
function findLogLines(
  calls: unknown[][],
  message: string,
): Record<string, unknown>[] {
  return calls
    .map((args) => {
      try {
        return JSON.parse(String(args[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (line): line is Record<string, unknown> =>
        line !== null && line.message === message,
    );
}

function makeSorobanError(
  variant: SorobanErrorCode = SorobanErrorCode.RpcTimeout,
): SorobanError {
  return new SorobanError(variant, `Simulated ${variant}`, {
    statusCode: 504,
  });
}

beforeEach(() => {
  sorobanRetryQueue.clear();
});

// ──────── computeBackoff ─────────────────────────────────────────────────────

describe("computeBackoff", () => {
  it("returns baseDelayMs for attempt 0", () => {
    const delay = computeBackoff(0, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5);
    // No jitter when random returns exactly 0.5 (the midpoint)
    expect(delay).toBe(DEFAULT_RETRY_QUEUE_CONFIG.baseDelayMs);
  });

  it("doubles delay each attempt (no jitter)", () => {
    expect(computeBackoff(0, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5)).toBe(1000);
    expect(computeBackoff(1, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5)).toBe(2000);
    expect(computeBackoff(2, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5)).toBe(4000);
  });

  it("caps delay at maxDelayMs", () => {
    const delay = computeBackoff(10, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5);
    expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_QUEUE_CONFIG.maxDelayMs);
  });

  it("applies negative jitter when random < 0.5", () => {
    const delay = computeBackoff(1, DEFAULT_RETRY_QUEUE_CONFIG, () => 0);
    // At random=0, jitter = -0.1 * 2000 = -200; 2000 - 200 = 1800
    expect(delay).toBeLessThan(2000);
  });

  it("applies positive jitter when random > 0.5", () => {
    const delay = computeBackoff(1, DEFAULT_RETRY_QUEUE_CONFIG, () => 1);
    // At random=1, jitter = +0.1 * 2000 = 200; 2000 + 200 = 2200
    expect(delay).toBeGreaterThan(2000);
  });

  it("does not return negative delays", () => {
    const config = { ...DEFAULT_RETRY_QUEUE_CONFIG, jitterFactor: 1 };
    const delay = computeBackoff(0, config, () => 0);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

// ──────── Enqueue ────────────────────────────────────────────────────────────

describe("enqueue", () => {
  it("enqueues a createStream operation successfully", () => {
    const result = sorobanRetryQueue.enqueue("createStream", {
      streamId: "stream-42",
      payload: { recipient: "GDVLR...123" },
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toMatch(/^soroban-retry-/);
  });

  it("enqueues a cancelStream operation successfully", () => {
    const result = sorobanRetryQueue.enqueue("cancelStream", {
      streamId: "stream-42",
    });
    expect(result.ok).toBe(true);
    expect(result.data?.id).toMatch(/^soroban-retry-/);
  });

  it("enqueues a fetchStream operation successfully", () => {
    const result = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "stream-42",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown operation", () => {
    const result = sorobanRetryQueue.enqueue(
      "unknownOp" as SorobanOperation,
      { streamId: "x" } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_OPERATION");
  });

  it("rejects a non-string operation", () => {
    const result = sorobanRetryQueue.enqueue(
      123 as never,
      { streamId: "x" } as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_OPERATION");
  });

  it("rejects null payload", () => {
    const result = sorobanRetryQueue.enqueue(
      "fetchStream",
      null as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects undefined payload", () => {
    const result = sorobanRetryQueue.enqueue(
      "fetchStream",
      undefined as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects a non-object payload", () => {
    const result = sorobanRetryQueue.enqueue(
      "fetchStream",
      "not-an-object" as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects a payload with missing streamId", () => {
    const result = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects a createStream payload without payload field", () => {
    const result = sorobanRetryQueue.enqueue(
      "createStream",
      // @ts-expect-error: deliberately missing payload field for test
      { streamId: "stream-1" },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("accepts a custom correlationId", () => {
    const result = sorobanRetryQueue.enqueue(
      "fetchStream",
      { streamId: "stream-42" },
      "my-custom-cid",
    );
    expect(result.ok).toBe(true);
    // Verify the entry has the custom correlation ID
    const entryResult = sorobanRetryQueue.getEntry(result.data!.id);
    expect(entryResult.ok).toBe(true);
    expect(entryResult.data?.correlationId).toBe("my-custom-cid");
  });

  it("auto-generates a correlationId when not provided", () => {
    const result = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "stream-42",
    });
    expect(result.ok).toBe(true);
    const entryResult = sorobanRetryQueue.getEntry(result.data!.id);
    expect(entryResult.data?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("emits a structured log on enqueue", () => {
    const capture = captureLogs();

    sorobanRetryQueue.enqueue("fetchStream", { streamId: "stream-42" });

    const lines = findLogLines(capture.logCalls, "retry_queue_enqueued");
    expect(lines).toHaveLength(1);
    expect(lines[0].operation).toBe("fetchStream");
    expect(lines[0].stream_id).toBe("stream-42");
    expect(lines[0].level).toBe("info");
    expect(typeof lines[0].correlation_id).toBe("string");
    expect(typeof lines[0].entry_id).toBe("string");

    capture.restore();
  });

  it("emits a warn log on validation failure", () => {
    const capture = captureLogs();

    sorobanRetryQueue.enqueue("unknownOp" as SorobanOperation, {
      streamId: "x",
    } as never);

    const lines = findLogLines(
      capture.warnCalls,
      "retry_queue_enqueue_validation_failed",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].error_code).toBe("INVALID_OPERATION");

    capture.restore();
  });
});

// ──────── Dequeue ────────────────────────────────────────────────────────────

describe("dequeue", () => {
  it("returns the oldest pending entry", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.enqueue("cancelStream", { streamId: "b" });

    const result = sorobanRetryQueue.dequeue();
    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
    expect((result.data?.payload as { streamId: string }).streamId).toBe("a");
  });

  it("returns null when the queue is empty", () => {
    const result = sorobanRetryQueue.dequeue();
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("does not return entries whose nextRetryAt is in the future", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });

    // Dequeue at a large timestamp (entry is immediately eligible since
    // nextRetryAt = Date.now() at enqueue time). Then fail it so the
    // entry's nextRetryAt becomes BASE_TIME + delay (~1000ms later).
    const BASE_TIME = 4_000_000_000_000;
    sorobanRetryQueue.dequeue(BASE_TIME);
    sorobanRetryQueue.markFailed(
      enqResult.data!.id,
      makeSorobanError(),
      BASE_TIME,
    );

    // nextRetryAt is now BASE_TIME + ~1000ms. Dequeue at BASE_TIME
    // should NOT return it (it's in the future relative to BASE_TIME).
    const tooSoon = sorobanRetryQueue.dequeue(BASE_TIME);
    expect(tooSoon.data).toBeNull();

    // At BASE_TIME + 5000 it should be eligible.
    const later = sorobanRetryQueue.dequeue(BASE_TIME + 5000);
    expect(later.data).not.toBeNull();
  });

  it("does not return entries in dead status", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const id = enqResult.data!.id;
    sorobanRetryQueue.dequeue(); // transition to processing

    // Exhaust retries
    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.markFailed(id, makeSorobanError());
      if (i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries - 1) {
        // Need to dequeue again after each markFailed that keeps it pending
        sorobanRetryQueue.dequeue(Infinity);
      }
    }

    const deqResult = sorobanRetryQueue.dequeue(Infinity);
    expect(deqResult.ok).toBe(true);
    expect(deqResult.data).toBeNull();
  });

  it("does not return entries in processing status", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.dequeue(); // first entry is now processing

    // Second dequeue should skip the processing entry
    const result = sorobanRetryQueue.dequeue();
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("transitions status to processing on dequeue", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const id = enqResult.data!.id;

    const deqResult = sorobanRetryQueue.dequeue();
    expect(deqResult.data?.status).toBe("processing");

    const entryResult = sorobanRetryQueue.getEntry(id);
    expect(entryResult.data?.status).toBe("processing");
  });

  it("returns entries with nextRetryAt exactly at now", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const entry = sorobanRetryQueue.getEntry(enqResult.data!.id);
    const exactTime = entry.data!.nextRetryAt;

    // Dequeue at exactly the same time
    const result = sorobanRetryQueue.dequeue(exactTime);
    expect(result.data).not.toBeNull();
  });

  it("returns the oldest eligible entry when multiple are pending", () => {
    // Enqueue at different times by manipulating nextRetryAt
    const r1 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "first" });
    const r2 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "second" });

    // Set the first entry's nextRetryAt to 5000
    const e1 = sorobanRetryQueue.getEntry(r1.data!.id);
    // We can't directly mutate — let's just rely on insertion order for FIFO
    // Both are eligible now, so first inserted should come first
    const deq = sorobanRetryQueue.dequeue();
    expect((deq.data?.payload as { streamId: string }).streamId).toBe("first");
  });

  it("emits a structured log on dequeue", () => {
    const capture = captureLogs();
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.dequeue();

    const lines = findLogLines(capture.logCalls, "retry_queue_dequeued");
    expect(lines).toHaveLength(1);
    expect(lines[0].operation).toBe("fetchStream");
    expect(lines[0].level).toBe("info");

    capture.restore();
  });
});

// ──────── Mark Complete ──────────────────────────────────────────────────────

describe("markComplete", () => {
  it("removes the entry from the queue", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const id = enqResult.data!.id;
    sorobanRetryQueue.dequeue();

    const result = sorobanRetryQueue.markComplete(id);
    expect(result.ok).toBe(true);

    const entryResult = sorobanRetryQueue.getEntry(id);
    expect(entryResult.data).toBeNull();
  });

  it("rejects an empty entry ID", () => {
    const result = sorobanRetryQueue.markComplete("");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_ENTRY_ID");
  });

  it("rejects a non-existent entry ID", () => {
    const result = sorobanRetryQueue.markComplete("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("rejects completing a non-processing entry", () => {
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const id = enqResult.data!.id;
    // Entry is still pending, not processing
    const result = sorobanRetryQueue.markComplete(id);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_STATE");
  });

  it("emits a structured log on completion", () => {
    const capture = captureLogs();
    const enqResult = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    const id = enqResult.data!.id;
    sorobanRetryQueue.dequeue();
    sorobanRetryQueue.markComplete(id);

    const lines = findLogLines(capture.logCalls, "retry_queue_completed");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");
    expect(lines[0].operation).toBe("fetchStream");

    capture.restore();
  });
});

// ──────── Mark Failed / Retry Scheduling ─────────────────────────────────────

describe("markFailed — retry scheduling", () => {
  function enqueueAndDequeue(streamId = "a"): string {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId });
    const id = r.data!.id;
    sorobanRetryQueue.dequeue();
    return id;
  }

  it("schedules a retry with backoff delay", () => {
    const id = enqueueAndDequeue();
    const result = sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe("pending");
    expect(result.data?.nextRetryAt).toBeGreaterThan(0);
  });

  it("increments the attempt counter on each failure", () => {
    const id = enqueueAndDequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.attempts).toBe(1);
  });

  it("rejects an empty entry ID", () => {
    const result = sorobanRetryQueue.markFailed("", makeSorobanError());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_ENTRY_ID");
  });

  it("rejects a non-SorobanError", () => {
    const id = enqueueAndDequeue();
    const result = sorobanRetryQueue.markFailed(id, new Error("plain error"));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_ERROR");
  });

  it("rejects a non-existent entry ID", () => {
    const result = sorobanRetryQueue.markFailed(
      "does-not-exist",
      makeSorobanError(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });

  it("rejects marking failed on a non-processing entry", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    // Not yet dequeued → still pending
    const result = sorobanRetryQueue.markFailed(
      r.data!.id,
      makeSorobanError(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_STATE");
  });

  it("emits a warn log on retry scheduling", () => {
    const capture = captureLogs();
    const id = enqueueAndDequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    const lines = findLogLines(
      capture.warnCalls,
      "retry_queue_retry_scheduled",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].attempt).toBe(1);
    expect(typeof lines[0].delay_ms).toBe("number");

    capture.restore();
  });

  it("logs the Soroban error variant, not the raw message (no PII)", () => {
    const capture = captureLogs();
    const id = enqueueAndDequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    const lines = findLogLines(
      capture.warnCalls,
      "retry_queue_retry_scheduled",
    );
    expect(lines[0].last_error_variant).toBe("RpcTimeout");
    // Raw error message must NOT appear in the log
    const rawLog = JSON.stringify(lines[0]);
    expect(rawLog).not.toContain("Simulated");

    capture.restore();
  });

  it("stores the last error on the entry", () => {
    const id = enqueueAndDequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);
    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.lastError).toBeInstanceOf(SorobanError);
    expect(entry.data?.lastError?.variant).toBe(SorobanErrorCode.RpcTimeout);
  });
});

// ──────── Retry Exhaustion ───────────────────────────────────────────────────

describe("retry exhaustion", () => {
  it("moves an entry to dead status after maxRetries failures", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.status).toBe("dead");
    expect(entry.data?.attempts).toBe(DEFAULT_RETRY_QUEUE_CONFIG.maxRetries);
  });

  it("emits an error log when retries are exhausted", () => {
    const capture = captureLogs();
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const lines = findLogLines(capture.errorCalls, "retry_queue_exhausted");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("error");
    expect(lines[0].attempts).toBe(DEFAULT_RETRY_QUEUE_CONFIG.maxRetries);

    capture.restore();
  });

  it("the dead-letter entry is not eligible for dequeue", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const deqResult = sorobanRetryQueue.dequeue(Infinity);
    expect(deqResult.data).toBeNull();
  });

  it("getDeadLetterEntries returns exhausted entries", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const dead = sorobanRetryQueue.getDeadLetterEntries();
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe(id);
    expect(dead[0].status).toBe("dead");
  });

  it("requeueDeadLetter moves a dead entry back to pending", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const requeueResult = sorobanRetryQueue.requeueDeadLetter(id);
    expect(requeueResult.ok).toBe(true);

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.status).toBe("pending");
    expect(entry.data?.attempts).toBe(0);
    expect(entry.data?.lastError).toBeNull();
  });

  it("requeueDeadLetter rejects a non-dead entry", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const result = sorobanRetryQueue.requeueDeadLetter(r.data!.id);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_STATE");
  });

  it("requeueDeadLetter rejects a non-existent ID", () => {
    const result = sorobanRetryQueue.requeueDeadLetter("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NOT_FOUND");
  });
});

// ──────── Retry Persistence ──────────────────────────────────────────────────

describe("retry persistence", () => {
  it("retains entries across multiple enqueue/dequeue cycles", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.enqueue("cancelStream", { streamId: "b" });
    sorobanRetryQueue.enqueue("createStream", {
      streamId: "c",
      payload: { recipient: "G..." },
    });

    expect(sorobanRetryQueue.getQueueDepth()).toBe(3);

    sorobanRetryQueue.dequeue();
    // One processing, two pending
    expect(sorobanRetryQueue.getQueueDepth()).toBe(2);
  });

  it("getEntry returns a defensive copy", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data).not.toBeNull();
    // Mutate the copy
    (entry.data as RetryQueueEntry).status = "dead";

    // Original must be unchanged
    const fresh = sorobanRetryQueue.getEntry(id);
    expect(fresh.data?.status).toBe("pending");
  });

  it("getDeadLetterEntries returns a defensive copy", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;
    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const dead = sorobanRetryQueue.getDeadLetterEntries();
    dead[0].status = "pending"; // mutate copy
    const fresh = sorobanRetryQueue.getDeadLetterEntries();
    expect(fresh[0].status).toBe("dead");
  });

  it("getEntry returns null for unknown ID (not an error)", () => {
    const result = sorobanRetryQueue.getEntry("does-not-exist");
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });
});

// ──────── Standardised Error Envelopes ───────────────────────────────────────

describe("standardised error envelopes", () => {
  it("every error has code, message, and correlationId", () => {
    const result = sorobanRetryQueue.enqueue(
      "" as SorobanOperation,
      {} as never,
    );

    expect(result.ok).toBe(false);
    const err = result.error!;
    expect(typeof err.code).toBe("string");
    expect(err.code.length).toBeGreaterThan(0);
    expect(typeof err.message).toBe("string");
    expect(err.message.length).toBeGreaterThan(0);
    expect(typeof err.correlationId).toBe("string");
    expect(err.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("success results have ok: true and no error field", () => {
    const result = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    });
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
  });

  it("markFailed error envelope includes the correlationId", () => {
    const result = sorobanRetryQueue.markFailed("", makeSorobanError());
    expect(result.ok).toBe(false);
    expect(result.error?.correlationId).toMatch(/^[0-9a-f-]+$/i);
  });
});

// ──────── Structured Logging Behaviour ───────────────────────────────────────

describe("structured logging behaviour", () => {
  it("all log entries are valid JSON with standard fields", () => {
    const capture = captureLogs();

    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });

    const allCalls = [
      ...capture.logCalls,
      ...capture.warnCalls,
      ...capture.errorCalls,
    ];
    expect(allCalls.length).toBeGreaterThan(0);

    for (const args of allCalls) {
      const parsed = JSON.parse(String(args[0]));
      expect(typeof parsed.level).toBe("string");
      expect(typeof parsed.message).toBe("string");
      expect(typeof parsed.timestamp).toBe("string");
      expect(parsed.service).toBe("soroban-retry-queue");
    }

    capture.restore();
  });

  it("log entries include correlation_id", () => {
    const capture = captureLogs();

    sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "a",
    }, "test-cid-123");

    const lines = findLogLines(capture.logCalls, "retry_queue_enqueued");
    expect(lines).toHaveLength(1);
    expect(lines[0].correlation_id).toBe("test-cid-123");

    capture.restore();
  });
});

// ──────── Correlation ID Propagation ─────────────────────────────────────────

describe("correlation ID propagation", () => {
  it("entry retains the correlationId across lifecycle transitions", () => {
    const cid = "propagation-test-cid";
    const r = sorobanRetryQueue.enqueue(
      "fetchStream",
      { streamId: "a" },
      cid,
    );
    const id = r.data!.id;

    // After dequeue, correlationId is preserved
    sorobanRetryQueue.dequeue();
    let entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.correlationId).toBe(cid);

    // After markFailed, correlationId is preserved
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);
    entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.correlationId).toBe(cid);
  });

  it("generated correlationIds are valid UUIDs", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const entry = sorobanRetryQueue.getEntry(r.data!.id);
    expect(entry.data?.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("multiple entries get unique correlationIds", () => {
    const r1 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const r2 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "b" });

    const e1 = sorobanRetryQueue.getEntry(r1.data!.id);
    const e2 = sorobanRetryQueue.getEntry(r2.data!.id);

    expect(e1.data?.correlationId).not.toBe(e2.data?.correlationId);
  });
});

// ──────── Configuration ──────────────────────────────────────────────────────

describe("configuration", () => {
  it("returns default config initially", () => {
    expect(sorobanRetryQueue.getConfig()).toEqual(DEFAULT_RETRY_QUEUE_CONFIG);
  });

  it("merges partial config updates", () => {
    const result = sorobanRetryQueue.setConfig({ maxRetries: 5 });
    expect(result.ok).toBe(true);
    expect(sorobanRetryQueue.getConfig().maxRetries).toBe(5);
    expect(sorobanRetryQueue.getConfig().baseDelayMs).toBe(
      DEFAULT_RETRY_QUEUE_CONFIG.baseDelayMs,
    );
  });

  it("rejects negative maxRetries", () => {
    const result = sorobanRetryQueue.setConfig({ maxRetries: -1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects non-integer maxRetries", () => {
    const result = sorobanRetryQueue.setConfig({ maxRetries: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects jitterFactor > 1", () => {
    const result = sorobanRetryQueue.setConfig({ jitterFactor: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("rejects negative baseDelayMs", () => {
    const result = sorobanRetryQueue.setConfig({ baseDelayMs: -100 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("INVALID_CONFIG");
  });

  it("getConfig returns a defensive copy", () => {
    const cfg = sorobanRetryQueue.getConfig();
    cfg.maxRetries = 99;
    expect(sorobanRetryQueue.getConfig().maxRetries).toBe(
      DEFAULT_RETRY_QUEUE_CONFIG.maxRetries,
    );
  });

  it("clear resets config to defaults", () => {
    sorobanRetryQueue.setConfig({ maxRetries: 10 });
    sorobanRetryQueue.clear();
    expect(sorobanRetryQueue.getConfig()).toEqual(DEFAULT_RETRY_QUEUE_CONFIG);
  });
});

// ──────── Queue Depth ────────────────────────────────────────────────────────

describe("getQueueDepth", () => {
  it("returns 0 for an empty queue", () => {
    expect(sorobanRetryQueue.getQueueDepth()).toBe(0);
  });

  it("counts only pending entries", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "b" });
    expect(sorobanRetryQueue.getQueueDepth()).toBe(2);

    // Dequeue one → now processing
    sorobanRetryQueue.dequeue();
    expect(sorobanRetryQueue.getQueueDepth()).toBe(1);
  });

  it("does not count processing entries", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.dequeue();
    expect(sorobanRetryQueue.getQueueDepth()).toBe(0);
  });

  it("does not count dead entries", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;
    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }
    expect(sorobanRetryQueue.getQueueDepth()).toBe(0);
  });
});

// ──────── Edge Cases ─────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles rapid enqueue/dequeue cycles without data loss", () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const r = sorobanRetryQueue.enqueue("fetchStream", {
        streamId: `stream-${i}`,
      });
      ids.push(r.data!.id);
    }

    expect(sorobanRetryQueue.getQueueDepth()).toBe(100);

    let dequeued = 0;
    let entry = sorobanRetryQueue.dequeue();
    while (entry.data) {
      sorobanRetryQueue.markComplete(entry.data.id);
      dequeued++;
      entry = sorobanRetryQueue.dequeue();
    }

    expect(dequeued).toBe(100);
    expect(sorobanRetryQueue.getQueueDepth()).toBe(0);
  });

  it("clear removes all entries", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    sorobanRetryQueue.enqueue("cancelStream", { streamId: "b" });

    sorobanRetryQueue.clear();
    expect(sorobanRetryQueue.getQueueDepth()).toBe(0);
    expect(sorobanRetryQueue.getDeadLetterEntries()).toHaveLength(0);
  });

  it("handles all three operation types in the same queue", () => {
    sorobanRetryQueue.enqueue("createStream", {
      streamId: "a",
      payload: { recipient: "G..." },
    });
    sorobanRetryQueue.enqueue("cancelStream", { streamId: "b" });
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "c" });

    expect(sorobanRetryQueue.getQueueDepth()).toBe(3);

    const first = sorobanRetryQueue.dequeue();
    expect(first.data?.operation).toBe("createStream");

    const second = sorobanRetryQueue.dequeue();
    expect(second.data?.operation).toBe("cancelStream");

    const third = sorobanRetryQueue.dequeue();
    expect(third.data?.operation).toBe("fetchStream");
  });

  it("processes entry through full lifecycle: enqueue → dequeue → fail → retry → complete", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    // First attempt: dequeue → fail
    sorobanRetryQueue.dequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    // Wait for retry window and dequeue again
    sorobanRetryQueue.dequeue(Infinity);
    sorobanRetryQueue.markComplete(id);

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data).toBeNull(); // removed after completion
  });

  it("handles dequeue when only non-eligible entries exist", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    // Dequeue and fail, scheduling a future retry
    sorobanRetryQueue.dequeue(0);
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);
    // nextRetryAt is in the future

    // Dequeue at the same timestamp → no eligible entries
    const deq = sorobanRetryQueue.dequeue(0);
    expect(deq.data).toBeNull();
  });
});

// ──────── Failure Recovery ───────────────────────────────────────────────────

describe("failure recovery", () => {
  it("requeueDeadLetter allows retrying exhausted entries", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    // Exhaust retries
    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    expect(sorobanRetryQueue.getDeadLetterEntries()).toHaveLength(1);

    // Requeue the dead letter
    sorobanRetryQueue.requeueDeadLetter(id);
    expect(sorobanRetryQueue.getDeadLetterEntries()).toHaveLength(0);
    expect(sorobanRetryQueue.getQueueDepth()).toBe(1);

    // Successfully process on the fresh attempt
    sorobanRetryQueue.dequeue();
    sorobanRetryQueue.markComplete(id);
    expect(sorobanRetryQueue.getEntry(id).data).toBeNull();
  });

  it("multiple entries can exhaust and recover independently", () => {
    const r1 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const r2 = sorobanRetryQueue.enqueue("fetchStream", { streamId: "b" });
    const id1 = r1.data!.id;
    const id2 = r2.data!.id;

    // Process entry 2 normally to completion first
    sorobanRetryQueue.dequeue(Infinity);
    sorobanRetryQueue.markComplete(id1);

    // Now exhaust entry 2 through all retries
    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      const dq = sorobanRetryQueue.dequeue(Infinity);
      expect(dq.data).not.toBeNull();
      sorobanRetryQueue.markFailed(id2, makeSorobanError(), Infinity);
    }

    // Entry 2 is now dead, entry 1 is completed
    expect(sorobanRetryQueue.getEntry(id2).data?.status).toBe("dead");
    expect(sorobanRetryQueue.getEntry(id1).data).toBeNull();

    // Requeue the dead letter and recover
    sorobanRetryQueue.requeueDeadLetter(id2);
    expect(sorobanRetryQueue.getEntry(id2).data?.status).toBe("pending");
    expect(sorobanRetryQueue.getEntry(id2).data?.attempts).toBe(0);
    expect(sorobanRetryQueue.getEntry(id2).data?.lastError).toBeNull();
  });
});

// ──────── Security: No Sensitive Data in Logs ────────────────────────────────

describe("security — no sensitive data in logs", () => {
  it("does not log the raw error message from SorobanError", () => {
    const capture = captureLogs();
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;
    sorobanRetryQueue.dequeue();
    sorobanRetryQueue.markFailed(id, makeSorobanError(), 0);

    const allLogs = [
      ...capture.logCalls,
      ...capture.warnCalls,
      ...capture.errorCalls,
    ].map((args) => String(args[0]));

    // The raw error message "Simulated RpcTimeout" must never appear
    for (const log of allLogs) {
      expect(log).not.toContain("Simulated RpcTimeout");
    }

    capture.restore();
  });

  it("does not log streamId or payload in error-level logs", () => {
    const capture = captureLogs();
    const r = sorobanRetryQueue.enqueue("fetchStream", {
      streamId: "sensitive-stream",
    });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    // Error logs for exhaustion should not contain the stream ID payload
    const errorLines = findLogLines(
      capture.errorCalls,
      "retry_queue_exhausted",
    );
    for (const line of errorLines) {
      const raw = JSON.stringify(line);
      // stream_id should not appear in exhaustion error logs
      expect(raw).not.toContain("sensitive-stream");
    }

    capture.restore();
  });
});

// ──────── Deterministic Retry Behaviour ──────────────────────────────────────

describe("deterministic retry behaviour", () => {
  it("backoff is deterministic when random source is fixed", () => {
    const delay1 = computeBackoff(0, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5);
    const delay2 = computeBackoff(0, DEFAULT_RETRY_QUEUE_CONFIG, () => 0.5);
    expect(delay1).toBe(delay2);
  });

  it("retry count is strictly bounded by maxRetries", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;

    for (let i = 0; i < DEFAULT_RETRY_QUEUE_CONFIG.maxRetries + 5; i++) {
      sorobanRetryQueue.dequeue(Infinity);
      const entry = sorobanRetryQueue.getEntry(id);
      if (entry.data?.status === "dead") break;
      sorobanRetryQueue.markFailed(id, makeSorobanError(), Infinity);
    }

    const entry = sorobanRetryQueue.getEntry(id);
    expect(entry.data?.status).toBe("dead");
    expect(entry.data!.attempts).toBeLessThanOrEqual(
      DEFAULT_RETRY_QUEUE_CONFIG.maxRetries,
    );
  });
});

// ──────── Duplicate Handling ─────────────────────────────────────────────────

describe("duplicate handling", () => {
  it("does not allow completing the same entry twice", () => {
    const r = sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const id = r.data!.id;
    sorobanRetryQueue.dequeue();
    sorobanRetryQueue.markComplete(id);

    const second = sorobanRetryQueue.markComplete(id);
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("NOT_FOUND");
  });

  it("does not allow dequeueing an already-processing entry", () => {
    sorobanRetryQueue.enqueue("fetchStream", { streamId: "a" });
    const first = sorobanRetryQueue.dequeue();
    expect(first.data).not.toBeNull();

    // Second dequeue should not return the same entry
    const second = sorobanRetryQueue.dequeue();
    expect(second.data).toBeNull();
  });
});
