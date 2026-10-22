import { isValidStellarPublicKey } from "../lib/stellar-address";
import { isFederationAddress } from "../utils/federation";

export const MAX_IMPORT_BYTES = 1 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const MAX_LABEL_LENGTH = 64;
export const MAX_NOTE_LENGTH = 256;

export interface ContactRow {
  label: string;
  address: string;
  federation?: string;
  note?: string;
  createdAt?: string;
}

export interface ContactExport {
  version: 1;
  contacts: ContactRow[];
}

export type Classification = "conflict" | "duplicate" | "invalid" | "new";

export interface ClassifiedRow {
  index: number;
  row: ContactRow;
  classification: Classification;
  reason?: string;
  existingId?: string;
  needsResolution?: boolean;
}

export type ConflictResolution = "skip" | "overwrite" | "keep-both";

export interface ExistingContact {
  id: string;
  label: string;
  address: string;
}

// ------------------------------------------------------------------------------
// CSV parser (RFC 4180)
// ------------------------------------------------------------------------------

/**
 * Minimal RFC 4180 CSV parser. Handles quoted fields with embedded
 * commas, newlines, and escaped double quotes. Returns an array of rows
 * where each row is an array of string fields.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const flushRow = () => {
    row.push(field);
    field = "";
    // If the row has at least one non-empty field, keep it.
    // Trailing blank lines are skipped.
    if (row.some((c) => c.length > 0)) {
      rows.push(row);
    }
    row = [];
  };

  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Normalize \r\n and \r\n
      flushRow();
      if (input[i + 1] === '\n') i += 2;
      else i += 1;
      continue;
    }
    if (ch === '\n') {
      flushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the final field/row if anything is left.
  if (field.length > 0 || row.length > 0) {
    flushRow();
  }

  return rows;
}

// ------------------------------------------------------------------------------
// Row validation
// ------------------------------------------------------------------------------

export interface RowValidation {
  valid: boolean;
  reason?: string;
}

export function validateRow(row: ContactRow): RowValidation {
  const label = (typeof row.label === "string" ? row.label : "").trim();
  if (label.length < 1 || label.length > MAX_LABEL_LENGTH) {
    return {
      valid: false,
      reason: `From 1 to ${MAX_LABEL_LENGTH} characters required in label.`,
    };
  }

  const address = (typeof row.address === "string" ? row.address : "").trim();
  if (!address) {
    return { valid: false, reason: "Address is required." };
  }

  const isStellar = isValidStellarPublicKey(address);
  const isFed = isFederationAddress(address);
  if (!isStellar && !isFed) {
    return {
      valid: false,
      reason: "Address is not a valid Stellar address or federation address.",
    };
  }

  if (row.note !== undefined && row.note !== null) {
    const note = String(row.note);
    if (note.length > MAX_NOTE_LENGTH) {
      return {
        valid: false,
        reason: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.`,
      };
    }
  }

  return { valid: true };
}

// ------------------------------------------------------------------------------
// Import parsing
// ------------------------------------------------------------------------------

export interface ParseResult {
  ok: boolean;
  error?: string;
  rows?: ContactRow[];
}

export function parseJsonImport(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON file." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "JSON file must contain an object." };
  }

  const obj = parsed as { version?: unknown; contacts?: unknown };
  if (obj.version !== 1) {
    return { ok: false, error: "Unsupported export version." };
  }
  if (!Array.isArray(obj.contacts)) {
    return { ok: false, error: "Missing contacts array." };
  }

  const rows: ContactRow[] = (obj.contacts as unknown[]).map((entry) => {
    const e = (entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {});
    return {
      label: typeof e.label === "string" ? e.label : "",
      address: typeof e.address === "string" ? e.address : "",
      federation: typeof e.federation === "string" ? e.federation : undefined,
      note: typeof e.note === "string" ? e.note : undefined,
      createdAt: typeof e.createdAt === "string" ? e.createdAt : undefined,
    };
  });

  return { ok: true, rows };
}

export function parseCsvImport(text: string): ParseResult {
  const table = parseCsv(text);
  if (table.length === 0) {
    return { ok: false, error: "CSV file is empty." };
  }

  const header = table[0].map((h) => h.trim().toLowerCase());
  const required = ["label", "address"];
  for (const req of required) {
    if (!header.includes(req)) {
      return { ok: false, error: `Missing required CSV column: ${req}.` };
    }
  }

  const id = header.indexOf("label");
  const ia = header.indexOf("address");
  const ifed = header.indexOf("federation");
  const inote = header.indexOf("note");
  const ic = header.indexOf("createdat");

  const rows: ContactRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    rows.push({
      label: id >= 0 ? (cells[id] ?? "") : "",
      address: ia >= 0 ? (cells[ia] ?? "") : "",
      federation: ifed >= 0 ? (cells[ifed] ?? "") : undefined,
      note: inote >= 0 ? (cells[inote] ?? "") : undefined,
      createdAt: ic >= 0 ? (cells[ic] ?? "") : undefined,
    });
  }

  return { ok: true, rows };
}

// ------------------------------------------------------------------------------
// Classification
// ------------------------------------------------------------------------------

export function classifyRows(
  rows: ContactRow[],
  existing: ExistingContact[],
): ClassifiedRow[] {
  const byAddress = new Map<string, ExistingContact>();
  for (const c of existing) {
    byAddress.set(c.address, c);
  }

  const seenAddresses = new Map<string, string>(); // address -> label

  return rows.map((row, index) => {
    const validation = validateRow(row);
    if (!validation.valid) {
      return {
        index,
        row,
        classification: "invalid" as const,
        reason: validation.reason,
      };
    }

    const address = row.address.trim();
    const label = row.label.trim();
    const needsResolution = isFederationAddress(address);

    const existing = byAddress.get(address);
    if (existing) {
      if (existing.label === label) {
        return {
          index,
          row,
          classification: "duplicate" as const,
          existingId: existing.id,
          needsResolution,
        };
      }
      return {
        index,
        row,
        classification: "conflict" as const,
        existingId: existing.id,
        needsResolution,
      };
    }

    // Dedupe against earlier rows in the same file.
    const seenLabel = seenAddresses.get(address);
    if (seenLabel !== undefined) {
      if (seenLabel === label) {
        return {
          index,
          row,
          classification: "duplicate" as const,
          needsResolution,
        };
      }
      return {
        index,
        row,
        classification: "conflict" as const,
        needsResolution,
      };
    }

    seenAddresses.set(address, label);
    return {
      index,
      row,
      classification: "new" as const,
      needsResolution,
    };
  });
}

// ------------------------------------------------------------------------------
// Export helpers
// ------------------------------------------------------------------------------

export function buildJsonExport(contacts: ContactRow[]): string {
  const payload: ContactExport = { version: 1, contacts };
  return JSON.stringify(payload, null, 2);
}

export const CONTACTS_CSV_HEADERS = ["label", "address", "federation", "note", "createdAt"] as const;

export function escapeCsvField(value: string): string {
  let safeValue = value;
  // Hardened: also prefix leading tab and carriage return.
  if (/^[=+\-@\t\r]/.test(safeValue)) {
    safeValue = "'" + safeValue;
  }
  if (/[",\n\r]/.test(safeValue)) {
    return `"${safeValue.replace(/"/g, '""')}"`;
  }
  return safeValue;
}

export function buildCsvExport(contacts: ContactRow[]): string {
  const header = CONTACTS_CSV_HEADERS.join(",");
  const lines = contacts.map((c) =>
    [c.label, c.address, c.federation ?? "", c.note ?? "", c.createdAt ?? ""]
      .map(escapeCsvField)
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

export const buildExportJson = buildJsonExport;
export const buildExportCsv = buildCsvExport;
export const classifyImport = classifyRows;

