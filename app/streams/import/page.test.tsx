/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ImportStreamsPage from "./page";

// If your runner is Vitest without globals, add:
// import { describe, it, expect, beforeEach } from "vitest";

const ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const HEADER = "recipient,rate,schedule,token,memo,external_id\n";

const csv = (n: number) =>
  HEADER +
  Array.from({ length: n }, (_, i) => `${ADDR},10,month,XLM,memo,ext-${i + 1}`).join("\n");

type Reply = { status: number; body: unknown };
let calls: { url: string; init: RequestInit }[];
let replies: Reply[];

const dryOk = (n: number): Reply => ({
  status: 207,
  body: {
    summary: { total: n, valid: n, failed: 0, imported: 0 },
    results: Array.from({ length: n }, (_, i) => ({ row: i + 1, status: "valid" })),
  },
});

const importOk = (n: number): Reply => ({
  status: 207,
  body: {
    summary: { total: n, valid: n, failed: 0, imported: n },
    results: Array.from({ length: n }, (_, i) => ({
      row: i + 1,
      status: "imported",
      streamId: `s-${i + 1}`,
    })),
  },
});

const errReply = (status: number, code: string, message: string): Reply => ({
  status,
  body: { error: { code, message } },
});

const keyOf = (c: { init: RequestInit }) =>
  (c.init.headers as Record<string, string>)["Idempotency-Key"];

function upload(content: string, name = "streams.csv") {
  const input = screen.getByLabelText(/choose a csv file/i);
  const file = new File([content], name, { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
}

async function toSubmitStep(content = csv(2), rows = 2) {
  upload(content);
  await screen.findByText("Ready to import");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  return screen.findByRole("button", { name: `Import ${rows} rows` });
}

beforeEach(() => {
  calls = [];
  replies = [];
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies.shift();
    if (!r) throw new Error("unexpected fetch call");
    return { status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
});

describe("ImportStreamsPage", () => {
  it("shows dry-run summary and a per-row error table", async () => {
    replies.push({
      status: 207,
      body: {
        summary: { total: 2, valid: 1, failed: 1, imported: 0 },
        results: [
          { row: 1, status: "valid" },
          {
            row: 2,
            status: "error",
            errors: [{ field: "recipient", code: "INVALID", message: "Bad address" }],
          },
        ],
      },
    });
    render(<ImportStreamsPage />);
    upload(csv(2));
    await screen.findByText("Ready to import");
    expect(calls[0].url).toBe("/api/streams/import?dryRun=true");
    expect(screen.getByText("Bad address")).toBeTruthy();
    expect(screen.getByText(/download error rows/i)).toBeTruthy();
  });

  it("reuses the same Idempotency-Key when retrying after a 504", async () => {
    replies.push(
      dryOk(2),
      errReply(504, "GATEWAY_TIMEOUT", "Timed out"),
      importOk(2),
    );
    render(<ImportStreamsPage />);
    fireEvent.click(await toSubmitStep());
    await screen.findByText("Timed out");
    fireEvent.click(screen.getByRole("button", { name: "Retry import" }));
    await screen.findByText(/streams from this import/i);

    const imports = calls.filter((c) => !c.url.includes("dryRun"));
    expect(imports).toHaveLength(2);
    expect(keyOf(imports[0])).toBeTruthy();
    expect(keyOf(imports[1])).toBe(keyOf(imports[0]));
  });

  it("mints a new key after IDEMPOTENCY_CONFLICT", async () => {
    replies.push(
      dryOk(2),
      errReply(409, "IDEMPOTENCY_CONFLICT", "Key reused"),
      importOk(2),
    );
    render(<ImportStreamsPage />);
    fireEvent.click(await toSubmitStep());
    await screen.findByText("Key reused");
    fireEvent.click(screen.getByRole("button", { name: "Import again" }));
    await screen.findByText(/streams from this import/i);

    const imports = calls.filter((c) => !c.url.includes("dryRun"));
    expect(keyOf(imports[1])).not.toBe(keyOf(imports[0]));
  });

  it("changing the file forces a new dry run and a new key", async () => {
    replies.push(
      dryOk(2),
      errReply(504, "GATEWAY_TIMEOUT", "Timed out"),
      dryOk(3),
      errReply(504, "GATEWAY_TIMEOUT", "Timed out"),
    );
    render(<ImportStreamsPage />);
    fireEvent.click(await toSubmitStep(csv(2), 2));
    await screen.findByText("Timed out");

    fireEvent.click(screen.getByRole("button", { name: /back to review/i }));
    fireEvent.click(await screen.findByRole("button", { name: /choose a different file/i }));
    fireEvent.click(await toSubmitStep(csv(3), 3));
    await screen.findByText("Timed out");

    expect(calls.filter((c) => c.url.includes("dryRun=true"))).toHaveLength(2);
    const imports = calls.filter((c) => !c.url.includes("dryRun"));
    expect(keyOf(imports[1])).not.toBe(keyOf(imports[0]));
  });

  it("rejects non-CSV files before any network call", async () => {
    render(<ImportStreamsPage />);
    upload("hello", "notes.txt");
    await screen.findByRole("alert");
    expect(calls).toHaveLength(0);
  });

  it("rejects more than 500 rows before any network call", async () => {
    render(<ImportStreamsPage />);
    upload(csv(501));
    await screen.findByRole("alert");
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly 500 rows", async () => {
    replies.push(dryOk(500));
    render(<ImportStreamsPage />);
    upload(csv(500));
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});