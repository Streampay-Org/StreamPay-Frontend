"use client";

/**
 * Streams CSV import wizard: Upload -> Review -> Submit -> Result.
 *
 * - Rows are parsed and validated in the browser (parseCsv.ts) and sent as JSON
 *   `{ rows }`, so row numbers in server results match the rows shown here.
 * - Review runs POST /api/streams/import?dryRun=true. The server is the source of
 *   truth (token allowlist etc.); invalid rows never block valid ones.
 * - Submit sends one Idempotency-Key per payload hash. Retries after a timeout or
 *   network failure reuse the same key; a changed file gets a new key and a new
 *   dry run; IDEMPOTENCY_CONFLICT mints a fresh key.
 */

import { useEffect, useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import type { ImportSummary, RowResult } from "@/app/api/streams/import/route";
import { StepIndicator, type Step } from "../new/components/StepIndicator";
import {
  MAX_ROWS,
  checkFile,
  errorRowsToCsv,
  parseImportCsv,
  toApiRows,
  type ImportRow,
  type ParseResult,
  type RowIssue,
} from "./parseCsv";

type ParsedOk = Extract<ParseResult, { ok: true }>;
type Phase = "upload" | "review" | "submit" | "result";

interface ApiOk {
  summary: ImportSummary;
  results: RowResult[];
}

interface ErrorEntry {
  row: number;
  values: ImportRow;
  errors: RowIssue[];
}

type CallOutcome =
  | { kind: "ok"; data: ApiOk }
  | { kind: "error"; code: string; message: string };

type DryRunState =
  | { status: "loading" }
  | { status: "done"; data: ApiOk }
  | { status: "error"; message: string };

type SubmitState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; code: string; message: string };

const PHASES: Phase[] = ["upload", "review", "submit", "result"];

const STEPS: Step[] = [
  { id: "upload", label: "Upload", description: "Choose a CSV file" },
  { id: "review", label: "Review", description: "Check rows with a dry run" },
  { id: "submit", label: "Submit", description: "Import the valid rows" },
  { id: "result", label: "Result", description: "See what was imported" },
];

const TEMPLATE_CSV =
  "recipient,rate,schedule,token,memo,external_id\r\n" +
  "REPLACE_WITH_STELLAR_PUBLIC_KEY,10,month,XLM,Example memo,example-1\r\n";

const csvHref = (text: string) =>
  `data:text/csv;charset=utf-8,${encodeURIComponent("\uFEFF" + text)}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** SHA-256 of the payload when available, otherwise a simple FNV-1a fallback. */
async function hashPayload(rows: ImportRow[]): Promise<string> {
  const text = JSON.stringify(rows);
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv-${(h >>> 0).toString(16)}-${text.length}`;
}

function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function callImport(
  rows: ImportRow[],
  opts: { dryRun: boolean; key?: string },
): Promise<CallOutcome> {
  const url = opts.dryRun ? "/api/streams/import?dryRun=true" : "/api/streams/import";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.dryRun && opts.key) headers["Idempotency-Key"] = opts.key;

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ rows }) });
  } catch {
    return {
      kind: "error",
      code: "NETWORK_ERROR",
      message: "Could not reach the server. Check your connection and try again.",
    };
  }

  const body: {
    summary?: ImportSummary;
    results?: RowResult[];
    error?: { code?: string; message?: string };
  } | null = await res.json().catch(() => null);

  if (res.status === 207 && body?.summary && Array.isArray(body.results)) {
    return { kind: "ok", data: { summary: body.summary, results: body.results } };
  }
  return {
    kind: "error",
    code: body?.error?.code ?? (res.status === 504 ? "GATEWAY_TIMEOUT" : "REQUEST_FAILED"),
    message: body?.error?.message ?? `The server responded with status ${res.status}.`,
  };
}

function guidanceFor(code: string): string {
  switch (code) {
    case "IDEMPOTENCY_CONFLICT":
      return "This import key was already used with different file contents, so the file has changed since it was first sent. A new key has been created. Review the rows, then import again. Rows that were already saved are reported as already imported, not created twice.";
    case "IDEMPOTENCY_IN_FLIGHT":
      return "The previous attempt is still running. Wait a few seconds, then retry. Retrying uses the same key, so nothing is created twice.";
    case "GATEWAY_TIMEOUT":
    case "NETWORK_ERROR":
      return "The request timed out or the connection dropped. Some rows may already be saved. Retrying is safe: it reuses the same key, and rows already saved are reported as already imported.";
    default:
      return "You can retry. The same key is reused, so nothing is created twice.";
  }
}

function errorEntries(results: RowResult[], parsed: ParsedOk): ErrorEntry[] {
  return results
    .filter((r) => r.status === "error" && parsed.rows[r.row - 1] !== undefined)
    .map((r) => ({
      row: r.row,
      values: parsed.rows[r.row - 1].values,
      errors: r.errors ?? [],
    }));
}

// ── Small presentational pieces ──────────────────────────────────────────────

function ErrorTable({ entries, caption }: { entries: ErrorEntry[]; caption: string }) {
  if (entries.length === 0) return null;
  const fallback: RowIssue[] = [
    { field: "row", code: "ERROR", message: "This row could not be imported." },
  ];
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Field</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.flatMap((entry) =>
              (entry.errors.length > 0 ? entry.errors : fallback).map((err, i) => (
                <tr key={`${entry.row}-${err.field}-${i}`}>
                  <td>{entry.row}</td>
                  <td>{err.field}</td>
                  <td>{err.message}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p>
        <a
          className="button button--secondary"
          href={csvHref(errorRowsToCsv(entries))}
          download="streams-import-errors.csv"
        >
          Download error rows (CSV)
        </a>
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImportStreamsPage() {
  const [phase, setPhase] = useState<Phase>("upload");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedOk | null>(null);
  const [dry, setDry] = useState<DryRunState>({ status: "loading" });
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });
  const [finished, setFinished] = useState<ApiOk | null>(null);
  const [dragging, setDragging] = useState(false);

  const keyRef = useRef<{ hash: string; key: string } | null>(null);
  const payloadRef = useRef<{ rows: ImportRow[]; hash: string } | null>(null);
  const runRef = useRef(0);
  const submittingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);

  // Move focus to the step heading when the step changes (not on first render).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [phase]);

  /** One key per payload hash: reused on retries, new when the content changes. */
  const keyFor = (hash: string): string => {
    if (!keyRef.current || keyRef.current.hash !== hash) {
      keyRef.current = { hash, key: newKey() };
    }
    return keyRef.current.key;
  };

  async function startDryRun(rows: ImportRow[], runId: number) {
    setDry({ status: "loading" });
    const outcome = await callImport(rows, { dryRun: true });
    if (runId !== runRef.current) return; // a newer file replaced this run
    setDry(
      outcome.kind === "ok"
        ? { status: "done", data: outcome.data }
        : { status: "error", message: outcome.message },
    );
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const problem = checkFile(file);
    if (problem) {
      setFileError(problem);
      return;
    }

    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setFileError("Could not read that file. Please try again.");
      return;
    }

    const result = parseImportCsv(text);
    if (!result.ok) {
      setFileError(result.error.message);
      return;
    }

    const rows = toApiRows(result.rows);
    const hash = await hashPayload(rows);
    keyFor(hash); // new content gets a new key; identical content keeps its key
    payloadRef.current = { rows, hash };

    const runId = ++runRef.current;
    setFileError(null);
    setFileName(file.name);
    setParsed(result);
    setSubmit({ status: "idle" });
    setFinished(null);
    setPhase("review");
    void startDryRun(rows, runId);
  }

  async function runImport() {
    const payload = payloadRef.current;
    if (!payload || submittingRef.current) return;
    submittingRef.current = true;
    setSubmit({ status: "loading" });

    const outcome = await callImport(payload.rows, {
      dryRun: false,
      key: keyFor(payload.hash),
    });
    submittingRef.current = false;

    if (outcome.kind === "ok") {
      setFinished(outcome.data);
      setSubmit({ status: "idle" });
      setPhase("result");
      return;
    }
    if (outcome.code === "IDEMPOTENCY_CONFLICT") {
      keyRef.current = { hash: payload.hash, key: newKey() };
    }
    setSubmit({ status: "error", code: outcome.code, message: outcome.message });
  }

  function resetAll() {
    runRef.current++;
    setPhase("upload");
    setParsed(null);
    setFileName("");
    setFileError(null);
    setSubmit({ status: "idle" });
    setFinished(null);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    void handleFile(e.dataTransfer.files?.[0]);
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const reviewResults = dry.status === "done" ? dry.data.results : [];
  const readyCount = reviewResults.filter((r) => r.status === "valid").length;
  const dupResults = reviewResults.filter((r) => r.status === "duplicate");
  const reviewErrors = parsed && dry.status === "done" ? errorEntries(reviewResults, parsed) : [];

  const importedResults = finished?.results.filter((r) => r.status === "imported") ?? [];
  const alreadyResults = finished?.results.filter((r) => r.status === "duplicate") ?? [];
  const finalErrors = finished && parsed ? errorEntries(finished.results, parsed) : [];
  const linkedResults = [...importedResults, ...alreadyResults]
    .filter((r) => r.streamId)
    .sort((a, b) => a.row - b.row);

  return (
    <div className="import-wizard" style={{ display: "grid", gap: "1.5rem" }}>
      <header>
        <h1>Import streams from CSV</h1>
        <StepIndicator steps={STEPS} currentStep={PHASES.indexOf(phase)} />
      </header>

      {phase === "upload" && (
        <section aria-labelledby="import-upload-title">
          <h2 id="import-upload-title" ref={headingRef} tabIndex={-1}>
            Upload your CSV
          </h2>
          <p id="import-help">
            Columns: recipient, rate (or amount), schedule, token (or asset), memo, external_id.
            Up to {MAX_ROWS} rows and 1 MB.{" "}
            <a href={csvHref(TEMPLATE_CSV)} download="streams-import-template.csv">
              Download template
            </a>
          </p>
          <div
  role="presentation"
  onDragOver={(e) => {
    e.preventDefault();
    setDragging(true);
  }}
  onDragLeave={() => setDragging(false)}
  onDrop={onDrop}
  style={{
    border: dragging ? "2px solid currentColor" : "2px dashed currentColor",
    borderRadius: "0.75rem",
    padding: "1.5rem",
  }}
>
  <label htmlFor="streams-csv-file">
    Choose a CSV file, or drag and drop it here
    <input
      id="streams-csv-file"
      type="file"
      accept=".csv,text/csv"
      aria-describedby="import-help"
      aria-invalid={fileError ? true : undefined}
      onChange={(e) => void handleFile(e.target.files?.[0])}
    />
  </label>
</div>
          {fileError && <p role="alert">{fileError}</p>}
        </section>
      )}

      {phase === "review" && parsed && (
        <section aria-labelledby="import-review-title">
          <h2 id="import-review-title" ref={headingRef} tabIndex={-1}>
            Review
          </h2>
          <p>
            {fileName}: {plural(parsed.rows.length, "row")} found.
          </p>

          {parsed.warnings.length > 0 && (
            <div>
              <h3>Warnings</h3>
              <ul>
                {parsed.warnings.map((w) => (
                  <li key={`${w.code}-${w.row}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {dry.status === "loading" && (
            <p role="status">Checking your rows with the server…</p>
          )}

          {dry.status === "error" && (
            <div>
              <p role="alert">{dry.message}</p>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  if (payloadRef.current) {
                    void startDryRun(payloadRef.current.rows, ++runRef.current);
                  }
                }}
              >
                Try the check again
              </button>
            </div>
          )}

          {dry.status === "done" && (
            <div>
              <h3>Summary</h3>
              <dl>
                <dt>Rows in file</dt>
                <dd>{dry.data.summary.total}</dd>
                <dt>Ready to import</dt>
                <dd>{readyCount}</dd>
                <dt>Repeated rows in this file</dt>
                <dd>{dupResults.length}</dd>
                <dt>Rows with errors</dt>
                <dd>{dry.data.summary.failed}</dd>
              </dl>

              {dupResults.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <caption>
                      Duplicate preview: these rows repeat an earlier row in this file and will
                      be skipped
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Row</th>
                        <th scope="col">Recipient</th>
                        <th scope="col">Rate</th>
                        <th scope="col">Schedule</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dupResults.map((r) => {
                        const v = parsed.rows[r.row - 1]?.values;
                        return (
                          <tr key={r.row}>
                            <td>{r.row}</td>
                            <td>{v?.recipient}</td>
                            <td>{v?.rate}</td>
                            <td>{v?.schedule}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p>
                Rows that were already imported in an earlier upload are detected when you
                submit, and are shown as already imported in the result.
              </p>

              <ErrorTable
                entries={reviewErrors}
                caption="Rows with errors: these are skipped, and all other rows still import"
              />
              {readyCount === 0 && <p role="status">There are no valid rows to import.</p>}
            </div>
          )}

          <p style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button type="button" className="button button--secondary" onClick={resetAll}>
              Choose a different file
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={dry.status !== "done" || readyCount === 0}
              onClick={() => setPhase("submit")}
            >
              Continue
            </button>
          </p>
        </section>
      )}

      {phase === "submit" && (
        <section aria-labelledby="import-submit-title" aria-busy={submit.status === "loading"}>
          <h2 id="import-submit-title" ref={headingRef} tabIndex={-1}>
            Submit
          </h2>
          <p>
            You are about to import {plural(readyCount, "row")}. {plural(reviewErrors.length, "row")}{" "}
            with errors and {plural(dupResults.length, "repeated row")} will be skipped.
          </p>

          {submit.status === "loading" && <p role="status">Importing…</p>}
          {submit.status === "error" && (
            <div role="alert">
              <p>{submit.message}</p>
              <p>{guidanceFor(submit.code)}</p>
            </div>
          )}

          <p style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="button button--secondary"
              disabled={submit.status === "loading"}
              onClick={() => setPhase("review")}
            >
              Back to review
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={submit.status === "loading"}
              onClick={() => void runImport()}
            >
              {submit.status === "loading"
                ? "Importing…"
                : submit.status === "error"
                  ? submit.code === "IDEMPOTENCY_CONFLICT"
                    ? "Import again"
                    : "Retry import"
                  : `Import ${plural(readyCount, "row")}`}
            </button>
          </p>
        </section>
      )}

      {phase === "result" && finished && (
        <section aria-labelledby="import-result-title">
          <h2 id="import-result-title" ref={headingRef} tabIndex={-1}>
            Result
          </h2>
          <p role="status">
            Imported {importedResults.length}, already imported {alreadyResults.length}, failed{" "}
            {finalErrors.length}.
          </p>
          <p>Rows saved by an earlier attempt are listed as already imported.</p>

          {linkedResults.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table>
                <caption>Streams from this import</caption>
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Status</th>
                    <th scope="col">Stream</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedResults.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      <td>{r.status === "imported" ? "Imported" : "Already imported"}</td>
                      <td>
                        <Link href={`/streams/${r.streamId}`}>{r.streamId}</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ErrorTable entries={finalErrors} caption="Rows that failed and were not imported" />

          <p style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button type="button" className="button button--secondary" onClick={resetAll}>
              Import another file
            </button>
            <Link className="button button--primary" href="/streams">
              Back to streams
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}