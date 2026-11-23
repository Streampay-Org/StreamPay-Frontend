import {
  MAX_FILE_BYTES,
  MAX_ROWS,
  checkFile,
  errorRowsToCsv,
  parseImportCsv,
  toApiRows,
  type ParseResult,
} from "./parseCsv";

// Must be checksum-valid Stellar keys; swap in keys from app/streams/fixtures.ts if these fail.
const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const ADDR_B = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const HEADER = "recipient,rate,schedule,token,memo,external_id";
const csv = (...lines: string[]) => lines.join("\n");

function ok(result: ParseResult): Extract<ParseResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

describe("parseImportCsv", () => {
  it("handles mixed-case headers and the amount/asset aliases", () => {
    const r = ok(
      parseImportCsv(
        csv("Recipient,Amount,Schedule,Asset,Memo,External_ID", `${ADDR_A},10,Month,USDC,rent,inv-1`),
      ),
    );
    expect(r.rows[0].values).toEqual({
      recipient: ADDR_A,
      rate: "10",
      schedule: "Month",
      token: "USDC",
      memo: "rent",
      external_id: "inv-1",
    });
    expect(r.rows[0].errors).toEqual([]);
  });

  it("prefers rate over amount, and falls back to amount when rate is empty", () => {
    const r = ok(
      parseImportCsv(
        csv("recipient,rate,amount,schedule", `${ADDR_A},5,9,day`, `${ADDR_A},,9,day`),
      ),
    );
    expect(r.rows[0].values.rate).toBe("5");
    expect(r.rows[1].values.rate).toBe("9");
  });

  it("strips a UTF-8 BOM so the first header still matches", () => {
    const r = ok(parseImportCsv("\uFEFF" + csv(HEADER, `${ADDR_A},1,day,,,`)));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].errors).toEqual([]);
  });

  it("handles CRLF, CR, blank lines and whitespace-only lines", () => {
    const crlf = ok(parseImportCsv(`${HEADER}\r\n${ADDR_A},1,day,,,\r\n\r\n   \r\n`));
    expect(crlf.rows).toHaveLength(1);
    const cr = ok(parseImportCsv(`${HEADER}\r${ADDR_A},1,day,,,\r${ADDR_B},2,day,,,`));
    expect(cr.rows).toHaveLength(2);
  });

  it("numbers rows consecutively, skipping blank lines", () => {
    const r = ok(parseImportCsv(csv(HEADER, `${ADDR_A},1,day,,,`, "", `${ADDR_B},2,day,,,`)));
    expect(r.rows.map((x) => x.row)).toEqual([1, 2]);
  });

  it("keeps quoted commas, escaped quotes and quoted newlines inside one cell", () => {
    const r = ok(
      parseImportCsv(
        csv(HEADER, `${ADDR_A},1,day,,"Hello, ""world""",`, `${ADDR_B},2,day,,"line1\nline2",`),
      ),
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].values.memo).toBe('Hello, "world"');
    expect(r.rows[1].values.memo).toBe("line1\nline2");
  });

  it("reports an unterminated quote", () => {
    const r = parseImportCsv(csv(HEADER, `${ADDR_A},1,day,,"oops,`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNTERMINATED_QUOTE");
  });

  it("reports empty files, header-only files and missing columns", () => {
    for (const input of ["", "  \n \n"]) {
      const r = parseImportCsv(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("EMPTY_FILE");
    }
    const headerOnly = parseImportCsv(HEADER);
    expect(headerOnly.ok).toBe(false);
    if (!headerOnly.ok) expect(headerOnly.error.code).toBe("NO_DATA_ROWS");

    const missing = parseImportCsv(csv("recipient,memo", "x,y"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("MISSING_COLUMNS");
      expect(missing.error.message).toMatch(/rate/);
      expect(missing.error.message).toMatch(/schedule/);
    }
  });

  describe("row cap", () => {
    const makeRows = (n: number) =>
      Array.from({ length: n }, (_, i) => `${ADDR_A},1,day,XLM,,id-${i}`);

    it("accepts exactly 500 rows, ignoring blank lines", () => {
      const r = ok(parseImportCsv(csv(HEADER, ...makeRows(MAX_ROWS), "", "")));
      expect(r.rows).toHaveLength(500);
    });

    it("rejects 501 rows before any network call", () => {
      const r = parseImportCsv(csv(HEADER, ...makeRows(MAX_ROWS + 1)));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("TOO_MANY_ROWS");
        expect(r.error.message).toMatch(/501/);
      }
    });
  });

  it("flags invalid rows with field-level errors without blocking valid rows", () => {
    const r = ok(
      parseImportCsv(
        csv(
          HEADER,
          `not-a-key,0,fortnight,,,`,
          `${ADDR_A},1.12345678,day,,,`,
          `${ADDR_A},,day,,,`,
          `${ADDR_B},2.5,week,XLM,ok,`,
        ),
      ),
    );
    const codes = (i: number) => r.rows[i].errors.map((e) => `${e.field}:${e.code}`);
    expect(codes(0)).toEqual([
      "recipient:INVALID_STELLAR_KEY",
      "rate:RATE_NOT_POSITIVE",
      "schedule:INVALID_SCHEDULE",
    ]);
    expect(codes(1)).toEqual(["rate:DECIMAL_PRECISION_EXCEEDED"]);
    expect(codes(2)).toEqual(["rate:MISSING_FIELD"]);
    expect(codes(3)).toEqual([]);
    expect(r.validCount).toBe(1);
    expect(r.invalidCount).toBe(3);
  });

  describe("duplicate external_id warnings", () => {
    it("warns for repeated ids and says when values differ", () => {
      const r = ok(
        parseImportCsv(
          csv(
            HEADER,
            `${ADDR_A},1,day,,,dup`,
            `${ADDR_B},2,day,,,dup`,
            `${ADDR_A},1,day,,,dup`,
          ),
        ),
      );
      expect(r.warnings.map((w) => w.row)).toEqual([2, 3]);
      expect(r.warnings[0].message).toMatch(/differ/);
      expect(r.warnings[1].message).not.toMatch(/differ/);
    });

    it("does not warn when the first row is invalid (the server imports the second)", () => {
      const r = ok(parseImportCsv(csv(HEADER, `bad,1,day,,,x`, `${ADDR_A},1,day,,,x`)));
      expect(r.warnings).toEqual([]);
    });
  });
});

describe("toApiRows", () => {
  it("keeps every row, invalid ones included, in order", () => {
    const r = ok(parseImportCsv(csv(HEADER, `bad,1,day,,,`, `${ADDR_A},2,day,,,`)));
    const rows = toApiRows(r.rows);
    expect(rows).toHaveLength(2);
    expect(rows[0].recipient).toBe("bad");
    expect(rows[1].recipient).toBe(ADDR_A);
  });
});

describe("checkFile", () => {
  it("accepts .csv in any case", () => {
    expect(checkFile({ name: "streams.CSV", size: 100 })).toBeNull();
  });
  it("rejects other extensions, empty files and files over 1 MB", () => {
    expect(checkFile({ name: "streams.txt", size: 100 })).toMatch(/csv/i);
    expect(checkFile({ name: "a.csv", size: 0 })).toMatch(/empty/i);
    expect(checkFile({ name: "a.csv", size: MAX_FILE_BYTES + 1 })).toMatch(/1 MB/);
    expect(checkFile({ name: "a.csv", size: MAX_FILE_BYTES })).toBeNull();
  });
});

describe("errorRowsToCsv", () => {
  it("escapes cells and neutralises formulas", () => {
    const text = errorRowsToCsv([
      {
        row: 2,
        values: {
          recipient: "=cmd",
          rate: "abc",
          schedule: "day",
          token: "",
          memo: 'say "hi", ok',
          external_id: "",
        },
        errors: [{ field: "rate", code: "INVALID_RATE_FORMAT", message: "bad rate" }],
      },
    ]);
    expect(text).toBe(
      [
        "row,recipient,rate,schedule,token,memo,external_id,errors",
        `2,'=cmd,abc,day,,"say ""hi"", ok",,rate: bad rate`,
        "",
      ].join("\r\n"),
    );
  });
});