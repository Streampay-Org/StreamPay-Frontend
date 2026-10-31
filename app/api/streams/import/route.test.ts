/** @jest-environment node */
jest.mock("@/app/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  getCorrelationContext: jest.fn().mockReturnValue({
    request_id: "test-req-id",
    correlation_id: "test-corr-id",
  }),
}));

import { POST, computeRowKey } from "./route";
import { getStore, resetDb } from "@/app/lib/db";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";
import { TimeoutError } from "@/app/lib/with-timeout";

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

const CSV_HEADER = "recipient,rate,schedule,token,memo";
const VALID_CSV_ROW = `${VALID_RECIPIENT},100,month,XLM,test memo`;
const ANOTHER_VALID_CSV_ROW = `${VALID_RECIPIENT},50.5,week,USDC:GA5ZGCJZD3JTVLFR5O3M6J6DMFJ3Y7QMJ7WJ7VZ3Z5VK5J3Z5J3Z5VK5,`;

let keyCounter = 0;
function nextKey(): string {
  keyCounter += 1;
  return `idem-key-${keyCounter}`;
}

function makeCsvRequest(csv: string, idempotencyKey: string | null = nextKey(), extraHeaders: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "text/csv", ...extraHeaders };
  if (idempotencyKey !== null) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request("http://localhost/api/streams/import", {
    method: "POST",
    headers,
    body: csv,
  });
}

function makeJsonRequest(body: unknown, idempotencyKey: string | null = nextKey(), extraHeaders: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extraHeaders };
  if (idempotencyKey !== null) {
    headers["Idempotency-Key"] = idempotencyKey;
  }
  return new Request("http://localhost/api/streams/import", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeDryRunRequest(body: unknown): Request {
  return new Request("http://localhost/api/streams/import?dryRun=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDryRunCsvRequest(csv: string): Request {
  return new Request("http://localhost/api/streams/import?dryRun=true", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csv,
  });
}

describe("POST /api/streams/import", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetDb();
    _resetAllowlistForTesting();
    addAllowedToken("XLM");
    addAllowedToken("USDC:GA5ZGCJZD3JTVLFR5O3M6J6DMFJ3Y7QMJ7WJ7VZ3Z5VK5J3Z5J3Z5VK5");
  });

  // ── CSV Content-Type ────────────────────────────────────────────────────────

  describe("CSV content-type", () => {
    it("imports a single valid CSV row", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}`;
      const res = await POST(makeCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 1, valid: 1, failed: 0, imported: 1 });
      expect(body.results).toHaveLength(1);
      expect(body.results[0].status).toBe("imported");
      expect(body.results[0].streamId).toMatch(/^stream-/);
    });

    it("imports multiple valid CSV rows", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}\n${ANOTHER_VALID_CSV_ROW}`;
      const res = await POST(makeCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 2, valid: 2, failed: 0, imported: 2 });
      expect(body.results).toHaveLength(2);
      expect(body.results[0].status).toBe("imported");
      expect(body.results[1].status).toBe("imported");
      expect(body.results[0].streamId).not.toBe(body.results[1].streamId);
    });

    it("returns errors for invalid CSV rows without blocking valid ones", async () => {
      const csv = [
        CSV_HEADER,
        VALID_CSV_ROW,
        "invalid-key,abc,bad-schedule,XLM,",
      ].join("\n");
      const res = await POST(makeCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 2, valid: 1, failed: 1, imported: 1 });
      expect(body.results[0].status).toBe("imported");
      expect(body.results[1].status).toBe("error");
      expect(body.results[1].errors.length).toBeGreaterThan(0);
    });

    it("rejects empty CSV body", async () => {
      const res = await POST(makeCsvRequest(""));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CSV");
    });

    it("rejects CSV with only a header row", async () => {
      const res = await POST(makeCsvRequest(CSV_HEADER));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CSV");
    });

    it("handles CSV with quoted fields containing commas", async () => {
      const csv = `${CSV_HEADER}\n"${VALID_RECIPIENT}","100","month","XLM","memo, with comma"`;
      const res = await POST(makeCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary.valid).toBe(1);
    });

    it("handles Windows-style line endings (CRLF)", async () => {
      const csv = `${CSV_HEADER}\r\n${VALID_CSV_ROW}`;
      const res = await POST(makeCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary.valid).toBe(1);
    });
  });

  // ── JSON with csv string ────────────────────────────────────────────────────

  describe("JSON with csv string", () => {
    it("imports rows from a csv field", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}`;
      const res = await POST(makeJsonRequest({ csv }));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 1, valid: 1, failed: 0, imported: 1 });
    });

    it("rejects empty csv string", async () => {
      const res = await POST(makeJsonRequest({ csv: "" }));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_CSV");
    });
  });

  // ── JSON with rows array ────────────────────────────────────────────────────

  describe("JSON with rows array", () => {
    it("imports rows from a rows array", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [
            { recipient: VALID_RECIPIENT, rate: "100", schedule: "month" },
          ],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 1, valid: 1, failed: 0, imported: 1 });
    });

    it("accepts alternative field names (amount, asset)", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [
            { recipient: VALID_RECIPIENT, amount: "100", schedule: "month", asset: "XLM" },
          ],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary.valid).toBe(1);
    });
  });

  // ── Input validation ────────────────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects non-JSON body", async () => {
      const req = new Request("http://localhost/api/streams/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const res = await POST(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("rejects body without csv or rows", async () => {
      const res = await POST(makeJsonRequest({}));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("rejects more than 500 rows", async () => {
      const rows = Array.from({ length: 501 }, () => ({
        recipient: VALID_RECIPIENT,
        rate: "100",
        schedule: "month",
      }));
      const res = await POST(makeJsonRequest({ rows }));
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error.code).toBe("TOO_MANY_ROWS");
    });

    it("allows exactly 500 rows", async () => {
      const rows = Array.from({ length: 500 }, () => ({
        recipient: VALID_RECIPIENT,
        rate: "100",
        schedule: "month",
      }));
      const res = await POST(makeJsonRequest({ rows }));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary.total).toBe(500);
    });

    it("rejects rows with missing recipient", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ rate: "100", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.results[0].errors[0].field).toBe("recipient");
    });

    it("rejects rows with invalid stellar key", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: "not-a-key", rate: "100", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.results[0].errors.some((e: { field: string }) => e.field === "recipient")).toBe(true);
    });

    it("rejects rows with invalid rate", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "not-a-number", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.results[0].errors.some((e: { field: string }) => e.field === "rate")).toBe(true);
    });

    it("rejects rows with invalid schedule", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "fortnightly" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.results[0].errors.some((e: { field: string }) => e.field === "schedule")).toBe(true);
    });

    it("rejects rows with token not in allowlist", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [
            {
              recipient: VALID_RECIPIENT,
              rate: "100",
              schedule: "month",
              token: "SHIB:GA5ZGCJZD3JTVLFR5O3M6J6DMFJ3Y7QMJ7WJ7VZ3Z5VK5J3Z5J3Z5VK5",
            },
          ],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.results[0].errors.some((e: { field: string }) => e.field === "token")).toBe(true);
    });
  });

  // ── Dry-run mode ────────────────────────────────────────────────────────────

  describe("dryRun mode", () => {
    it("validates rows without creating streams (JSON)", async () => {
      const res = await POST(
        makeDryRunRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 1, valid: 1, failed: 0 });
      expect(body.results[0].status).toBe("valid");
      expect(body.results[0].streamId).toBeUndefined();
      expect(body.summary.imported).toBeUndefined();
    });

    it("validates rows without creating streams (CSV)", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}`;
      const res = await POST(makeDryRunCsvRequest(csv));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 1, valid: 1, failed: 0 });
      expect(body.results[0].status).toBe("valid");
    });

    it("reports validation errors in dryRun mode", async () => {
      const res = await POST(
        makeDryRunRequest({
          rows: [{ recipient: "bad", rate: "abc", schedule: "" }],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary.failed).toBe(1);
      expect(body.results[0].status).toBe("error");
      expect(body.results[0].errors.length).toBeGreaterThan(0);
    });

    it("does not persist any streams in dryRun mode", async () => {
      const { streamRepository } = getStore();
      const beforeCount = streamRepository.streams.size;

      await POST(
        makeDryRunRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );

      expect(streamRepository.streams.size).toBe(beforeCount);
    });
  });

  // ── Actual persistence ──────────────────────────────────────────────────────

  describe("stream creation", () => {
    it("persists streams in the repository", async () => {
      const { streamRepository } = getStore();
      const beforeCount = streamRepository.streams.size;

      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);

      expect(streamRepository.streams.size).toBe(beforeCount + 1);
    });

    it("sets correct stream properties", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [
            {
              recipient: VALID_RECIPIENT,
              rate: "100",
              schedule: "month",
              token: "XLM",
              memo: "test import",
            },
          ],
        }),
      );
      expect(res.status).toBe(207);

      const body = await res.json();
      const streamId = body.results[0].streamId;

      const { streamRepository } = getStore();
      const stream = streamRepository.streams.get(streamId);
      expect(stream).toBeDefined();
      expect(stream!.recipient).toBe(VALID_RECIPIENT);
      expect(stream!.rate).toBe("100");
      expect(stream!.schedule).toBe("month");
      expect(stream!.token).toBe("XLM");
      expect(stream!.memo).toBe("test import");
      expect(stream!.status).toBe("draft");
    });

    it("uses XLM as default token", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );
      const body = await res.json();
      const streamId = body.results[0].streamId;

      const { streamRepository } = getStore();
      const stream = streamRepository.streams.get(streamId);
      expect(stream!.token).toBe("XLM");
    });
  });

  // ── Response shape ──────────────────────────────────────────────────────────

  describe("response shape", () => {
    it("returns summary and results", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );
      const body = await res.json();
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("results");
      expect(Array.isArray(body.results)).toBe(true);
    });

    it("returns 207 Multi-Status", async () => {
      const res = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, rate: "100", schedule: "month" }],
        }),
      );
      expect(res.status).toBe(207);
    });
  });

  // ── Idempotency, row identity & timeout safety ─────────────────────────────

  describe("idempotency and per-row deduplication", () => {
    it("1. imports 3 valid rows with key K, retry with K returns identical response and keeps 3 new streams", async () => {
      const { streamRepository } = getStore();
      const initialCount = streamRepository.streams.size;
      const csv = [
        CSV_HEADER,
        `${VALID_RECIPIENT},10,day,XLM,memo-1`,
        `${VALID_RECIPIENT},20,week,XLM,memo-2`,
        `${VALID_RECIPIENT},30,month,XLM,memo-3`,
      ].join("\n");

      const firstRes = await POST(makeCsvRequest(csv, "key-K"));
      expect(firstRes.status).toBe(207);
      expect(firstRes.headers.get("Idempotency-Replay")).toBe("false");
      const firstBody = await firstRes.json();
      expect(firstBody.summary).toEqual({ total: 3, valid: 3, failed: 0, imported: 3 });
      expect(streamRepository.streams.size).toBe(initialCount + 3);

      const secondRes = await POST(makeCsvRequest(csv, "key-K"));
      expect(secondRes.status).toBe(207);
      expect(secondRes.headers.get("Idempotency-Replay")).toBe("true");
      const secondBody = await secondRes.json();
      expect(secondBody).toEqual(firstBody);
      expect(streamRepository.streams.size).toBe(initialCount + 3);
    });

    it("2. returns 409 IDEMPOTENCY_CONFLICT for same key K with different CSV", async () => {
      const csv1 = `${CSV_HEADER}\n${VALID_RECIPIENT},10,day,XLM,memo-1`;
      const csv2 = `${CSV_HEADER}\n${VALID_RECIPIENT},20,day,XLM,memo-2`;

      const firstRes = await POST(makeCsvRequest(csv1, "key-conflict"));
      expect(firstRes.status).toBe(207);

      const secondRes = await POST(makeCsvRequest(csv2, "key-conflict"));
      expect(secondRes.status).toBe(409);
      const body = await secondRes.json();
      expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("returns 409 IDEMPOTENCY_IN_FLIGHT when an identical key is currently in flight", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}`;
      const [firstRes, secondRes] = await Promise.all([
        POST(makeCsvRequest(csv, "key-inflight")),
        POST(makeCsvRequest(csv, "key-inflight")),
      ]);

      const statuses = [firstRes.status, secondRes.status].sort();
      expect(statuses).toEqual([207, 409]);

      const conflictRes = firstRes.status === 409 ? firstRes : secondRes;
      const conflictBody = await conflictRes.json();
      expect(conflictBody.error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
    });

    it("3. returns 400 IDEMPOTENCY_KEY_REQUIRED when key is missing and dryRun=false", async () => {
      const csv = `${CSV_HEADER}\n${VALID_CSV_ROW}`;
      const res = await POST(makeCsvRequest(csv, null));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("4. deduplicates two identical rows in one CSV (one imported, one duplicate)", async () => {
      const { streamRepository } = getStore();
      const initialCount = streamRepository.streams.size;
      const csv = [CSV_HEADER, VALID_CSV_ROW, VALID_CSV_ROW].join("\n");

      const res = await POST(makeCsvRequest(csv, "key-dup-in-file"));
      expect(res.status).toBe(207);

      const body = await res.json();
      expect(body.summary).toEqual({ total: 2, valid: 2, failed: 0, imported: 1 });
      expect(body.results[0].status).toBe("imported");
      expect(body.results[0].streamId).toMatch(/^stream-/);
      expect(body.results[1]).toEqual({
        row: 2,
        status: "duplicate",
        streamId: body.results[0].streamId,
      });
      expect(streamRepository.streams.size).toBe(initialCount + 1);
    });

    it("5. reports duplicate with original streamId when re-importing the same external_id with a new key", async () => {
      const { streamRepository } = getStore();
      const initialCount = streamRepository.streams.size;
      const headerWithExt = "recipient,rate,schedule,token,memo,external_id";
      const csv1 = `${headerWithExt}\n${VALID_RECIPIENT},100,month,XLM,first memo,payroll-row-42`;
      const csv2 = `${headerWithExt}\n${VALID_RECIPIENT},250,week,XLM,updated memo,payroll-row-42`;

      const res1 = await POST(makeCsvRequest(csv1, "key-ext-1"));
      expect(res1.status).toBe(207);
      const body1 = await res1.json();
      const originalStreamId = body1.results[0].streamId;
      expect(body1.results[0].status).toBe("imported");
      expect(originalStreamId).toMatch(/^stream-/);

      const res2 = await POST(makeCsvRequest(csv2, "key-ext-2"));
      expect(res2.status).toBe(207);
      const body2 = await res2.json();
      expect(body2.summary).toEqual({ total: 1, valid: 1, failed: 0, imported: 0 });
      expect(body2.results[0]).toEqual({
        row: 1,
        status: "duplicate",
        streamId: originalStreamId,
      });
      expect(streamRepository.streams.size).toBe(initialCount + 1);
    });

    it("6. simulated timeout after 2 of 5 rows, then retry results in 5 streams total with no duplicates", async () => {
      const { streamRepository } = getStore();
      const initialCount = streamRepository.streams.size;
      const originalSet = streamRepository.streams.set.bind(streamRepository.streams);

      let setCalls = 0;
      const setSpy = jest
        .spyOn(streamRepository.streams, "set")
        .mockImplementation((id, stream) => {
          setCalls += 1;
          if (setCalls === 3) {
            throw new TimeoutError(50);
          }
          originalSet(id, stream);
        });

      const csv = [
        CSV_HEADER,
        `${VALID_RECIPIENT},10,day,XLM,row-1`,
        `${VALID_RECIPIENT},20,day,XLM,row-2`,
        `${VALID_RECIPIENT},30,day,XLM,row-3`,
        `${VALID_RECIPIENT},40,day,XLM,row-4`,
        `${VALID_RECIPIENT},50,day,XLM,row-5`,
      ].join("\n");

      try {
        const firstRes = await POST(makeCsvRequest(csv, "key-timeout-retry"));
        expect(firstRes.status).toBe(504);
        expect(streamRepository.streams.size).toBe(initialCount + 2);

        setSpy.mockRestore();

        const retryRes = await POST(makeCsvRequest(csv, "key-timeout-retry"));
        expect(retryRes.status).toBe(207);
        const retryBody = await retryRes.json();

        expect(retryBody.summary).toEqual({
          total: 5,
          valid: 5,
          failed: 0,
          imported: 3,
        });
        expect(retryBody.results[0].status).toBe("duplicate");
        expect(retryBody.results[0].streamId).toMatch(/^stream-/);
        expect(retryBody.results[1].status).toBe("duplicate");
        expect(retryBody.results[1].streamId).toMatch(/^stream-/);
        expect(retryBody.results[2].status).toBe("imported");
        expect(retryBody.results[3].status).toBe("imported");
        expect(retryBody.results[4].status).toBe("imported");

        expect(streamRepository.streams.size).toBe(initialCount + 5);
      } finally {
        setSpy.mockRestore();
      }
    });

    it("7. dryRun=true without a key succeeds and never touches streamRepository or idempotencyStore", async () => {
      const { idempotencyStore, streamRepository } = getStore();
      const initialStreams = streamRepository.streams.size;
      expect(idempotencyStore.size).toBe(0);

      const csv = [
        CSV_HEADER,
        VALID_CSV_ROW,
        VALID_CSV_ROW,
      ].join("\n");

      const res = await POST(makeDryRunCsvRequest(csv));
      expect(res.status).toBe(207);
      const body = await res.json();
      expect(body.results[0].status).toBe("valid");
      expect(body.results[1].status).toBe("duplicate");
      expect(streamRepository.streams.size).toBe(initialStreams);
      expect(idempotencyStore.size).toBe(0);
    });

    it("8. row with token rejected at validation (malformed or disallowed) returns error and is never persisted as XLM", async () => {
      const { streamRepository } = getStore();
      const initialCount = streamRepository.streams.size;

      const res = await POST(
        makeJsonRequest(
          {
            rows: [
              {
                recipient: VALID_RECIPIENT,
                rate: "100",
                schedule: "month",
                token: "MALFORMED_TOKEN_WITHOUT_ISSUER",
              },
              {
                recipient: VALID_RECIPIENT,
                rate: "100",
                schedule: "month",
                token: "DOGE:GA5ZGCJZD3JTVLFR5O3M6J6DMFJ3Y7QMJ7WJ7VZ3Z5VK5J3Z5J3Z5VK5",
              },
            ],
          },
          "key-bad-tokens",
        ),
      );

      expect(res.status).toBe(207);
      const body = await res.json();
      expect(body.summary).toEqual({ total: 2, valid: 0, failed: 2, imported: 0 });
      expect(body.results[0].status).toBe("error");
      expect(body.results[0].errors[0].code).toBe("INVALID_TOKEN");
      expect(body.results[1].status).toBe("error");
      expect(body.results[1].errors[0].code).toBe("TOKEN_NOT_ALLOWED");
      expect(streamRepository.streams.size).toBe(initialCount);
    });

    it("handles escaped double-quotes in CSV and caller-scoped row deduplication", async () => {
      const csv = `${CSV_HEADER}\n"${VALID_RECIPIENT}","100","month","XLM","memo with ""quotes"""`;
      const resA = await POST(
        makeCsvRequest(csv, "caller-a-key", { "Actor-Wallet-Address": "GCALLERA" }),
      );
      expect(resA.status).toBe(207);
      const bodyA = await resA.json();
      expect(bodyA.summary.imported).toBe(1);

      // Different caller importing the same row is not treated as duplicate of caller A
      const resB = await POST(
        makeCsvRequest(csv, "caller-b-key", { "Actor-Wallet-Address": "GCALLERB" }),
      );
      expect(resB.status).toBe(207);
      const bodyB = await resB.json();
      expect(bodyB.summary.imported).toBe(1);
      expect(bodyB.results[0].streamId).not.toBe(bodyA.results[0].streamId);
    });

    it("computeRowKey uses external_id when provided and content hash otherwise", () => {
      const base = {
        recipient: VALID_RECIPIENT,
        rate: "100",
        schedule: "month",
        token: "XLM",
        memo: "m",
        external_id: "",
      };
      const hashKey = computeRowKey(base, "XLM");
      expect(hashKey).toMatch(/^[a-f0-9]{64}$/);
      expect(computeRowKey({ ...base, external_id: "custom-1" }, "XLM")).toBe("custom-1");
    });

    it("handles missing rate, header-only JSON csv, non-object rows, and expired idempotency entries", async () => {
      const headerOnlyRes = await POST(makeJsonRequest({ csv: CSV_HEADER }));
      expect(headerOnlyRes.status).toBe(400);

      const missingRateRes = await POST(
        makeJsonRequest({
          rows: [{ recipient: VALID_RECIPIENT, schedule: "month" }, null],
        }),
      );
      expect(missingRateRes.status).toBe(207);
      const missingRateBody = await missingRateRes.json();
      expect(missingRateBody.results[0].errors[0].field).toBe("rate");
      expect(missingRateBody.results[1].status).toBe("error");

      // Expired request & row idempotency entries are lazily evicted
      const { idempotencyStore } = getStore();
      idempotencyStore.set("streams.import.req.anonymous:expired-key", {
        fingerprint: "old",
        expiresAt: Date.now() - 1000,
      });
      idempotencyStore.set("streams.import.req.anonymous:corrupt-key", {
        fingerprint: "any",
        expiresAt: Date.now() + 10000,
      });
      idempotencyStore.set("streams.import.row.anonymous:expired-row", {
        streamId: "stream-missing",
        expiresAt: Date.now() - 1000,
      });

      const res1 = await POST(
        makeJsonRequest(
          {
            rows: [
              {
                recipient: VALID_RECIPIENT,
                rate: "100",
                schedule: "month",
                external_id: "expired-row",
              },
            ],
          },
          "expired-key",
        ),
      );
      expect(res1.status).toBe(207);
      const body1 = await res1.json();
      expect(body1.results[0].status).toBe("imported");
    });
  });
});
