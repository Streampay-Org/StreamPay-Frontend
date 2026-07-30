/** @jest-environment node */
import { POST } from "./route";
import { getStore, resetDb } from "@/app/lib/db";
import { _resetAllowlistForTesting, addAllowedToken } from "@/app/lib/token-allowlist";

const VALID_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

const CSV_HEADER = "recipient,rate,schedule,token,memo";
const VALID_CSV_ROW = `${VALID_RECIPIENT},100,month,XLM,test memo`;
const ANOTHER_VALID_CSV_ROW = `${VALID_RECIPIENT},50.5,week,USDC:GA5ZGCJZD3JTVLFR5O3M6J6DMFJ3Y7QMJ7WJ7VZ3Z5VK5J3Z5J3Z5VK5,`;

function makeCsvRequest(csv: string): Request {
  return new Request("http://localhost/api/streams/import", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csv,
  });
}

function makeJsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/streams/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
});
