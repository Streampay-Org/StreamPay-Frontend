/**
 * @jest-environment node
 *
 * Documentation contract test for `docs/api/multi-recipient-stream.md`
 * (issue #1652).
 *
 * The bug this guards against: the page documented
 * `POST /api/v1/streams/multi`, a route that does not exist, on an API version
 * that is deprecated. Nothing in CI noticed, because prose is not compiled.
 *
 * These assertions bind the page to the code:
 *   - it must name the v2 path and must not name the phantom v1 path;
 *   - it must state the endpoint's status explicitly;
 *   - it must document the 20-recipient cap and the 100% allocation rule;
 *   - its request example must be byte-equal to what the wizard actually
 *     posts (`buildMultiRecipientPayload`);
 *   - every error code the validator can emit must be listed in the page.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  MAX_RECIPIENTS,
  buildMultiRecipientPayload,
  validateMultiRecipientStreamBody,
} from "@/app/lib/multi-recipient";

const DOC_PATH = join(__dirname, "..", "api", "multi-recipient-stream.md");
const doc = readFileSync(DOC_PATH, "utf8");

const KEY_A = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const EMAIL_A = "ada@example.com";

/** Extract the first ```json fenced block that appears after `anchor`. */
function firstJsonBlockAfter(anchor: string): Record<string, unknown> {
  const anchorIndex = doc.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`Documentation anchor not found: ${JSON.stringify(anchor)}`);
  }

  const fenceStart = doc.indexOf("```json", anchorIndex);
  if (fenceStart === -1) {
    throw new Error(`No JSON example after ${JSON.stringify(anchor)}`);
  }

  const bodyStart = doc.indexOf("\n", fenceStart) + 1;
  const fenceEnd = doc.indexOf("```", bodyStart);
  return JSON.parse(doc.slice(bodyStart, fenceEnd));
}

/** Inputs the documented request example is supposed to describe. */
const EXAMPLE_INPUT = {
  name: "GrantFox Q3 Distribution",
  token: "XLM",
  totalAmount: 10000,
  startTime: "2026-09-01T09:00:00.000Z",
  endTime: "2026-12-31T23:59:00.000Z",
  recipients: [
    { address: KEY_A, percentage: 50, amount: 5000 },
    { address: EMAIL_A, percentage: 50, amount: 5000 },
  ],
};

/** Untyped view of the example, so deliberately malformed bodies can be built. */
const BASE = EXAMPLE_INPUT as unknown as Record<string, unknown>;

// ── Endpoint path ────────────────────────────────────────────────────────────

describe("documented endpoint", () => {
  it("names the v2 path", () => {
    expect(doc).toContain("/api/v2/streams/multi");
  });

  it("never points integrators at the phantom v1 path", () => {
    // The v1 path may only appear inside the explicit warning that it is not
    // a valid integration target.
    const mentions = doc.split("/api/v1/streams/multi").length - 1;
    expect(mentions).toBeLessThanOrEqual(1);
    expect(doc).toMatch(/no \/api\/v1\/streams\/multi route|no `\/api\/v1\/streams\/multi` route/i);
  });

  it("explains that v1 is deprecated", () => {
    expect(doc).toMatch(/v1 API is deprecated/i);
    expect(doc).toContain("410 Gone");
  });

  it("links the v2 migration guide", () => {
    expect(doc).toContain("../api-v2-migration.md");
  });
});

// ── Explicit status ──────────────────────────────────────────────────────────

describe("endpoint status", () => {
  it("states the status explicitly", () => {
    expect(doc).toMatch(/\*\*Status:\s*Live\.\*\*/);
  });

  it("distinguishes itself from a proposal", () => {
    expect(doc).toMatch(/not a proposal/i);
  });

  it("names the route that implements it", () => {
    expect(doc).toContain("app/api/v2/streams/multi/route.ts");
  });
});

// ── Validation rules ─────────────────────────────────────────────────────────

describe("documented validation rules", () => {
  it(`documents the ${MAX_RECIPIENTS}-recipient cap`, () => {
    expect(MAX_RECIPIENTS).toBe(20);
    expect(doc).toContain("MAX_RECIPIENTS = 20");
    expect(doc).toContain("TOO_MANY_RECIPIENTS");
    expect(doc).toMatch(/at most 20 recipients/i);
  });

  it("documents the 100% allocation rule", () => {
    expect(doc).toMatch(/sum to \*\*100\*\*/);
    expect(doc).toContain("ALLOCATION_MISMATCH");
    expect(doc).toMatch(/0\.001 percentage points/);
  });

  it("documents the numeric precision of the response", () => {
    expect(doc).toContain("4 decimal places");
    expect(doc).toContain("7-decimal precision");
  });

  it("documents the atomicity guarantee", () => {
    expect(doc).toMatch(/never leaves a partial fan-out behind/i);
  });

  it("documents that one fan-out costs one quota unit", () => {
    expect(doc).toMatch(/consumes \*\*one\*\* unit/i);
  });

  it("lists every error code the validator can emit", () => {
    const bodies: unknown[] = [
      null,
      {},
      { ...BASE, name: "  " },
      { ...BASE, name: "x".repeat(121) },
      { ...BASE, token: "USDT" },
      { ...BASE, token: 42 },
      { ...BASE, totalAmount: 0 },
      { ...BASE, totalAmount: "10000" },
      { ...BASE, startTime: "not-a-date" },
      { ...BASE, endTime: "not-a-date" },
      { ...BASE, endTime: EXAMPLE_INPUT.startTime },
      { ...BASE, recipients: undefined },
      { ...BASE, recipients: [] },
      { ...BASE, recipients: ["nope"] },
      { ...BASE, recipients: [{ address: "", percentage: 100 }] },
      { ...BASE, recipients: [{ address: "GABC123", percentage: 100 }] },
      { ...BASE, recipients: [{ address: KEY_A, percentage: "50" }] },
      {
        ...BASE,
        recipients: [
          { address: KEY_A, percentage: -1 },
          { address: EMAIL_A, percentage: 101 },
        ],
      },
      { ...BASE, recipients: [{ address: KEY_A, percentage: 99.999999 }] },
      { ...BASE, recipients: [{ address: KEY_A, percentage: 100, amount: -1 }] },
      { ...BASE, recipients: [{ address: KEY_A, percentage: 100, amount: "1" }] },
      {
        ...BASE,
        recipients: [
          { address: KEY_A, percentage: 50, amount: 1 },
          { address: EMAIL_A, percentage: 50, amount: 5000 },
        ],
      },
      {
        ...BASE,
        recipients: new Array(MAX_RECIPIENTS + 1).fill(0).map(() => ({
          address: KEY_A,
          percentage: 100 / (MAX_RECIPIENTS + 1),
        })),
      },
    ];

    const emitted = new Set<string>();
    for (const body of bodies) {
      for (const error of validateMultiRecipientStreamBody(body)) {
        emitted.add(error.code);
      }
    }

    // Sanity check: the battery above must actually exercise the validator.
    expect(emitted.size).toBeGreaterThanOrEqual(15);

    for (const code of emitted) {
      expect(doc).toContain(code);
    }
  });
});

// ── Request example matches the UI payload ───────────────────────────────────

describe("request example", () => {
  const example = firstJsonBlockAfter("## Request");

  it("is exactly what the wizard posts", () => {
    expect(example).toEqual(buildMultiRecipientPayload(EXAMPLE_INPUT));
  });

  it("passes the shared validator", () => {
    expect(validateMultiRecipientStreamBody(example)).toEqual([]);
  });

  it("names both supported recipient address forms", () => {
    expect(example.recipients).toEqual([
      { address: KEY_A, percentage: 50, amount: 5000 },
      { address: EMAIL_A, percentage: 50, amount: 5000 },
    ]);
  });
});

// ── Response example ─────────────────────────────────────────────────────────

describe("201 response example", () => {
  const response = firstJsonBlockAfter("## Response");

  it("uses the v2 field names", () => {
    expect(Object.keys(response).sort()).toEqual([
      "allocated_percentage",
      "created_at",
      "end_at",
      "id",
      "kind",
      "links",
      "name",
      "recipient_count",
      "recipients",
      "settlement",
      "start_at",
      "status",
      "token",
      "total_amount",
    ]);
    expect(response.settlement).toBeNull();
    expect(response.status).toBe("draft");
  });

  it("never uses the deprecated v1 field names", () => {
    for (const legacy of ["createdAt", "updatedAt", "nextAction", "settlementTxHash"]) {
      expect(doc).not.toContain(`"${legacy}"`);
    }
  });

  it("reports amounts and percentages as fixed-precision strings", () => {
    expect(response.total_amount).toMatch(/^\d+\.\d{7}$/);
    expect(response.allocated_percentage).toMatch(/^\d+\.\d{4}$/);

    const recipients = response.recipients as Array<Record<string, string>>;
    expect(recipients).toHaveLength(2);
    for (const recipient of recipients) {
      expect(recipient.amount).toMatch(/^\d+\.\d{7}$/);
      expect(recipient.percentage).toMatch(/^\d+\.\d{4}$/);
      expect(recipient.stream_id).toMatch(/^stream-/);
    }
  });

  it("satisfies the conservation invariant it claims", () => {
    const recipients = response.recipients as Array<Record<string, string>>;
    const total = recipients.reduce((sum, r) => sum + Number(r.amount), 0);
    const percentage = recipients.reduce((sum, r) => sum + Number(r.percentage), 0);

    expect(total).toBeCloseTo(Number(response.total_amount), 7);
    expect(percentage).toBeCloseTo(Number(response.allocated_percentage), 7);
    expect(recipients.every((r) => Number(r.amount) > 0)).toBe(true);
  });
});

// ── Error envelope ───────────────────────────────────────────────────────────

describe("error envelope example", () => {
  const envelope = firstJsonBlockAfter("## Errors");

  it("uses the project's standard envelope", () => {
    expect(Object.keys(envelope)).toEqual(["error"]);
    expect(Object.keys(envelope.error as Record<string, unknown>).sort()).toEqual([
      "code",
      "details",
      "message",
      "request_id",
    ]);
  });

  it("shows a per-field detail entry", () => {
    const details = (envelope.error as { details: Array<Record<string, string>> }).details;
    expect(details[0]).toMatchObject({ field: "recipients", code: "ALLOCATION_MISMATCH" });
  });
});
