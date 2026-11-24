/**
 * Client-side CSV parsing and row validation for the streams import wizard.
 *
 * Row numbers match the server: 1-based position among non-blank data rows
 * (header excluded), so they line up with the `row` field in the API results.
 * The server stays the source of truth (token allowlist, cross-import dedupe);
 * this module only catches problems early.
 */

import { isValidStellarPublicKey } from "@/app/lib/stellar-address";
import { STELLAR_MAX_I64, STROOPS_SCALE } from "@/app/lib/amount";

/** Keep in sync with SUPPORTED_SCHEDULES in app/lib/stream-validation.ts (a test enforces this). */
export const CLIENT_SCHEDULES = ["second", "minute", "hour", "day", "week", "month", "year"] as const;

const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const MAX_DECIMALS = 7;

export const MAX_ROWS = 500;
export const MAX_FILE_BYTES = 1024 * 1024; // 1 MB

export interface ImportRow {
  recipient: string;
  rate: string;
  schedule: string;
  token: string;
  memo: string;
  external_id: string;
}

export interface RowIssue {
  field: string;
  code: string;
  message: string;
}

export interface ParsedRow {
  row: number;
  values: ImportRow;
  errors: RowIssue[];
}

export interface ImportWarning {
  row: number;
  code: "DUPLICATE_EXTERNAL_ID";
  message: string;
}

export type ParseErrorCode =
  | "EMPTY_FILE"
  | "NO_DATA_ROWS"
  | "MISSING_COLUMNS"
  | "TOO_MANY_ROWS"
  | "UNTERMINATED_QUOTE";

export type ParseResult =
  | {
      ok: true;
      rows: ParsedRow[];
      warnings: ImportWarning[];
      validCount: number;
      invalidCount: number;
    }
  | { ok: false; error: { code: ParseErrorCode; message: string } };

const fail = (code: ParseErrorCode, message: string): ParseResult => ({
  ok: false,
  error: { code, message },
});

/** RFC 4180-style tokenizer: quotes, escaped quotes, CRLF/LF/CR, quoted newlines. */
function tokenize(text: string): { records: string[][]; unterminatedQuote: boolean } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let pending = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      pending = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      pending = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      pending = false;
    } else {
      field += ch;
      pending = true;
    }
  }
  if (pending) {
    record.push(field);
    records.push(record);
  }
  return { records, unterminatedQuote: inQuotes };
}

/** Mirrors the server's row normalisation (rate|amount, token|asset). */
function toImportRow(raw: Record<string, string>): ImportRow {
  return {
    recipient: (raw.recipient ?? "").trim(),
    rate: (raw.rate || raw.amount || "").trim(),
    schedule: (raw.schedule ?? "").trim(),
    token: (raw.token || raw.asset || "").trim(),
    memo: (raw.memo ?? "").trim(),
    external_id: (raw.external_id ?? "").trim(),
  };
}

/**
 * Browser-safe copy of the server's field rules for recipient, rate and
 * schedule, with the same error codes. (The shared server validator imports
 * Node's `crypto`, so it cannot be bundled into client code.)
 */
function validateRow(values: ImportRow): RowIssue[] {
  const errors: RowIssue[] = [];
  const add = (field: string, code: string, message: string) =>
    errors.push({ field, code, message });

  if (!values.recipient) {
    add("recipient", "MISSING_FIELD", "recipient is required and must be a non-empty string.");
  } else if (!isValidStellarPublicKey(values.recipient)) {
    add(
      "recipient",
      "INVALID_STELLAR_KEY",
      "recipient must be a valid Stellar public key (56-char string starting with G).",
    );
  }

  const rate = values.rate;
  if (!rate) {
    add("rate", "MISSING_FIELD", "rate is required and must be a non-empty string.");
  } else if (!DECIMAL_PATTERN.test(rate)) {
    add("rate", "INVALID_RATE_FORMAT", "rate must be a positive decimal number (e.g. 100 or 50.5).");
  } else {
    const [whole = "", fraction = ""] = rate.split(".");
    const allZeros = /^0+$/.test(whole) && (fraction.length === 0 || /^0+$/.test(fraction));
    if (allZeros) add("rate", "RATE_NOT_POSITIVE", "rate must be greater than zero.");
    if (fraction.length > MAX_DECIMALS) {
      add("rate", "DECIMAL_PRECISION_EXCEEDED", `rate supports at most ${MAX_DECIMALS} decimal places.`);
    } else if (!allZeros) {
      const stroops = BigInt(whole) * STROOPS_SCALE + BigInt(`${fraction}0000000`.slice(0, 7));
      if (stroops > STELLAR_MAX_I64) {
        add("rate", "RATE_TOO_LARGE", "rate exceeds Stellar int64 stroop bounds.");
      }
    }
  }

  if (!values.schedule) {
    add("schedule", "MISSING_FIELD", "schedule is required and must be a non-empty string.");
  } else if (!(CLIENT_SCHEDULES as readonly string[]).includes(values.schedule.toLowerCase())) {
    add("schedule", "INVALID_SCHEDULE", `schedule must be one of: ${CLIENT_SCHEDULES.join(", ")}.`);
  }

  return errors;
}

export function parseImportCsv(input: string): ParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const { records, unterminatedQuote } = tokenize(text);

  if (unterminatedQuote) {
    return fail(
      "UNTERMINATED_QUOTE",
      "A quoted value is missing its closing quote. Check the file for a stray \" character.",
    );
  }

  // Blank lines and rows with only empty cells are skipped, like the server does.
  const nonBlank = records.filter((cells) => cells.some((c) => c.trim() !== ""));
  if (nonBlank.length === 0) {
    return fail("EMPTY_FILE", "This file is empty.");
  }

  const header = nonBlank[0].map((h) => h.trim().toLowerCase());
  const missing: string[] = [];
  if (!header.includes("recipient")) missing.push("recipient");
  if (!header.includes("rate") && !header.includes("amount")) missing.push("rate (or amount)");
  if (!header.includes("schedule")) missing.push("schedule");
  if (missing.length > 0) {
    return fail("MISSING_COLUMNS", `Missing required column(s): ${missing.join(", ")}.`);
  }

  const dataRecords = nonBlank.slice(1);
  if (dataRecords.length === 0) {
    return fail("NO_DATA_ROWS", "The file has a header but no data rows.");
  }
  if (dataRecords.length > MAX_ROWS) {
    return fail(
      "TOO_MANY_ROWS",
      `This file has ${dataRecords.length} rows. The maximum is ${MAX_ROWS} per import.`,
    );
  }

  const rows: ParsedRow[] = dataRecords.map((cells, index) => {
    const raw: Record<string, string> = Object.create(null);
    header.forEach((name, j) => {
      raw[name] = cells[j]?.trim() ?? "";
    });
    const values = toImportRow(raw);
    return { row: index + 1, values, errors: validateRow(values) };
  });

  // The server silently skips a later valid row that repeats an external_id.
  const warnings: ImportWarning[] = [];
  const firstValid = new Map<string, ParsedRow>();
  for (const r of rows) {
    const id = r.values.external_id;
    if (!id || r.errors.length > 0) continue;
    const first = firstValid.get(id);
    if (!first) {
      firstValid.set(id, r);
      continue;
    }
    const differs = (Object.keys(r.values) as (keyof ImportRow)[]).some(
      (k) => k !== "external_id" && r.values[k] !== first.values[k],
    );
    warnings.push({
      row: r.row,
      code: "DUPLICATE_EXTERNAL_ID",
      message: `Row ${r.row} repeats external_id "${id}" from row ${first.row}; it will be skipped as a duplicate${differs ? " even though its values differ" : ""}.`,
    });
  }

  const invalidCount = rows.filter((r) => r.errors.length > 0).length;
  return { ok: true, rows, warnings, validCount: rows.length - invalidCount, invalidCount };
}

/** All rows, invalid ones included, so server row numbers match ours. */
export function toApiRows(rows: ParsedRow[]): ImportRow[] {
  return rows.map((r) => ({ ...r.values }));
}

/** Returns an error message, or null when the file is acceptable. */
export function checkFile(file: { name: string; size: number }): string | null {
  if (!/\.csv$/i.test(file.name)) return "Only .csv files are supported.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > MAX_FILE_BYTES) return "This file is too large. The limit is 1 MB.";
  return null;
}

const ERROR_CSV_COLUMNS = [
  "row",
  "recipient",
  "rate",
  "schedule",
  "token",
  "memo",
  "external_id",
  "errors",
];

function escapeCell(value: string): string {
  // Neutralise spreadsheet formulas in the downloaded file.
  const safe = /^[=+@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function errorRowsToCsv(
  entries: { row: number; values: ImportRow; errors: RowIssue[] }[],
): string {
  const lines = entries.map(({ row, values, errors }) =>
    [
      String(row),
      values.recipient,
      values.rate,
      values.schedule,
      values.token,
      values.memo,
      values.external_id,
      errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    ]
      .map(escapeCell)
      .join(","),
  );
  return [ERROR_CSV_COLUMNS.join(","), ...lines].join("\r\n") + "\r\n";
}