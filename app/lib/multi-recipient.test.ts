/**
 * @jest-environment node
 *
 * Tests for app/lib/multi-recipient.ts — the shared fan-out contract used by
 * both POST /api/v2/streams/multi and the /streams/new/multi wizard.
 *
 * The documented rules in docs/api/multi-recipient-stream.md are asserted
 * here so the docs cannot silently drift from the implementation.
 */

import {
  ALLOCATION_TARGET_PERCENTAGE,
  MAX_RECIPIENTS,
  PERCENTAGE_DECIMALS,
  allocationSumsToTarget,
  buildMultiRecipientPayload,
  deriveAllocationAmounts,
  deriveSingleAmount,
  formatAmount,
  formatPercentage,
  isValidRecipientAddress,
  resolveAllocations,
  validateMultiRecipientStreamBody,
  type MultiRecipientStreamRequest,
} from "./multi-recipient";

/** Checksum-valid ed25519 Strkey (same fixture the other validation suites use). */
const KEY_A = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";
const EMAIL_A = "ada@example.com";

function validBody(overrides: Partial<MultiRecipientStreamRequest> = {}) {
  return {
    name: "GrantFox Q3 Distribution",
    token: "XLM",
    totalAmount: 10000,
    startTime: "2026-09-01T09:00:00.000Z",
    endTime: "2026-12-31T23:59:00.000Z",
    recipients: [
      { address: KEY_A, percentage: 50, amount: 5000 },
      { address: EMAIL_A, percentage: 50, amount: 5000 },
    ],
    ...overrides,
  };
}

/** Codes reported for a given field, for concise assertions. */
function codesFor(errors: Array<{ field: string; code: string }>, field: string): string[] {
  return errors.filter((e) => e.field === field).map((e) => e.code);
}

// ── Address validation ───────────────────────────────────────────────────────

describe("isValidRecipientAddress", () => {
  it("accepts a checksum-valid Stellar public key", () => {
    expect(isValidRecipientAddress(KEY_A)).toBe(true);
  });

  it("accepts surrounding whitespace around a Stellar key", () => {
    expect(isValidRecipientAddress(`  ${KEY_A}  `)).toBe(true);
  });

  it("accepts a registered email address", () => {
    expect(isValidRecipientAddress(EMAIL_A)).toBe(true);
  });

  it("rejects a truncated or mistyped Stellar key", () => {
    expect(isValidRecipientAddress("GABC123")).toBe(false);
  });

  it("rejects a Stellar key with a broken checksum", () => {
    // Flip the final character so the length and prefix still look right.
    const broken = `${KEY_A.slice(0, -1)}${KEY_A.endsWith("A") ? "B" : "A"}`;
    expect(isValidRecipientAddress(broken)).toBe(false);
  });

  it("rejects an email without a domain", () => {
    expect(isValidRecipientAddress("ada@")).toBe(false);
    expect(isValidRecipientAddress("ada@example")).toBe(false);
  });

  it("rejects an over-long address", () => {
    expect(isValidRecipientAddress(`${"a".repeat(255)}@example.com`)).toBe(false);
  });
});

// ── Allocation arithmetic ────────────────────────────────────────────────────

describe("allocationSumsToTarget", () => {
  it("accepts an exact 100% split", () => {
    expect(allocationSumsToTarget([50, 50])).toBe(true);
  });

  it("accepts a single 100% recipient", () => {
    expect(allocationSumsToTarget([100])).toBe(true);
  });

  it("tolerates 4-decimal rounding drift from an equal split", () => {
    // 100 / 3 rounded to 4 decimals three times = 99.9999.
    expect(allocationSumsToTarget([33.3333, 33.3333, 33.3334])).toBe(true);
  });

  it("rejects a split that is meaningfully short of 100%", () => {
    expect(allocationSumsToTarget([50, 49.9])).toBe(false);
  });

  it("rejects a split that exceeds 100%", () => {
    expect(allocationSumsToTarget([60, 60])).toBe(false);
  });

  it("rejects an empty allocation", () => {
    expect(allocationSumsToTarget([])).toBe(false);
  });
});

describe("deriveSingleAmount", () => {
  it("returns half the total for a 50% share", () => {
    expect(deriveSingleAmount(10000, 50)).toBe(5000);
  });

  it("rounds to the token's 7-decimal precision", () => {
    // A third of 1 unit is not representable in 7 decimals; the API rounds
    // rather than emitting a longer fraction.
    const third = deriveSingleAmount(1, 100 / 3);
    expect(third).toBe(0.3333333);
    expect(third.toFixed(7)).toBe("0.3333333");
  });

  it("does not depend on the leg's position in the allocation", () => {
    // A single 50% leg and the first of two 50% legs must agree; only the
    // remainder-absorbing last leg may differ.
    expect(deriveSingleAmount(10000, 50)).toBe(5000);
    expect(deriveAllocationAmounts(10000, [50, 50])[0]).toBe(5000);
  });
});

describe("deriveAllocationAmounts", () => {
  it("splits an even two-way allocation exactly", () => {
    expect(deriveAllocationAmounts(10000, [50, 50])).toEqual([5000, 5000]);
  });

  it("makes the legs sum back to the total despite rounding", () => {
    const amounts = deriveAllocationAmounts(1000, [33.3333, 33.3333, 33.3334]);
    const sum = amounts.reduce((total, a) => total + a, 0);
    expect(sum).toBeCloseTo(1000, 7);
  });

  it("does not strand dust for a 3-way split of 1000", () => {
    const amounts = deriveAllocationAmounts(1000, [33.3333, 33.3333, 33.3334]);
    expect(amounts.every((a) => a > 0)).toBe(true);
    expect(amounts[2]).toBeCloseTo(333.334, 7);
  });

  it("handles the 20-recipient equal split of an indivisible total", () => {
    const percentages = new Array(MAX_RECIPIENTS).fill(5);
    const amounts = deriveAllocationAmounts(100, percentages);
    expect(amounts.reduce((total, a) => total + a, 0)).toBeCloseTo(100, 7);
  });

  it("returns an empty array for no recipients", () => {
    expect(deriveAllocationAmounts(1000, [])).toEqual([]);
  });
});

describe("resolveAllocations", () => {
  it("trims addresses and pairs them with derived amounts", () => {
    const resolved = resolveAllocations(10000, [
      { address: `  ${KEY_A}  `, percentage: 25 },
      { address: EMAIL_A, percentage: 75 },
    ]);

    expect(resolved[0]).toEqual({ address: KEY_A, percentage: 25, amount: 2500 });
    expect(resolved[1]).toEqual({ address: EMAIL_A, percentage: 75, amount: 7500 });
  });
});

describe("formatting", () => {
  it("renders percentages with 4 decimals", () => {
    expect(formatPercentage(33.3333)).toBe("33.3333");
    expect(formatPercentage(ALLOCATION_TARGET_PERCENTAGE)).toBe("100.0000");
    expect(PERCENTAGE_DECIMALS).toBe(4);
  });

  it("renders amounts with 7 decimals", () => {
    expect(formatAmount(5000)).toBe("5000.0000000");
  });
});

// ── Payload builder ──────────────────────────────────────────────────────────

describe("buildMultiRecipientPayload", () => {
  it("produces the documented request shape", () => {
    const payload = buildMultiRecipientPayload({
      name: "  GrantFox Q3 Distribution  ",
      token: "XLM",
      totalAmount: 10000,
      startTime: "2026-09-01T09:00:00.000Z",
      endTime: "2026-12-31T23:59:00.000Z",
      recipients: [
        { address: `  ${KEY_A} `, percentage: 50, amount: 5000 },
        { address: EMAIL_A, percentage: 50, amount: 5000 },
      ],
    });

    expect(Object.keys(payload).sort()).toEqual([
      "endTime",
      "name",
      "recipients",
      "startTime",
      "token",
      "totalAmount",
    ]);
    expect(payload.name).toBe("GrantFox Q3 Distribution");
    expect(payload.recipients[0].address).toBe(KEY_A);
    // Amounts are recomputed from the percentages, not echoed from the caller.
    expect(payload.recipients.map((r) => r.amount)).toEqual([5000, 5000]);
  });

  it("round-trips through the validator", () => {
    const payload = buildMultiRecipientPayload({
      name: "Round trip",
      token: "USDC",
      totalAmount: 300,
      startTime: "2026-01-01T00:00:00.000Z",
      endTime: "2026-02-01T00:00:00.000Z",
      recipients: [
        { address: KEY_A, percentage: 33.3333, amount: 99.9999 },
        { address: EMAIL_A, percentage: 66.6667, amount: 200.0001 },
      ],
    });

    expect(validateMultiRecipientStreamBody(payload)).toEqual([]);
  });
});

// ── Validator: happy path ────────────────────────────────────────────────────

describe("validateMultiRecipientStreamBody", () => {
  it("accepts a well-formed two-recipient fan-out", () => {
    expect(validateMultiRecipientStreamBody(validBody())).toEqual([]);
  });

  it("accepts a body that omits the optional per-recipient amount", () => {
    const body = validBody();
    delete (body.recipients[0] as { amount?: number }).amount;
    delete (body.recipients[1] as { amount?: number }).amount;
    expect(validateMultiRecipientStreamBody(body)).toEqual([]);
  });

  it("accepts exactly MAX_RECIPIENTS recipients", () => {
    const recipients = new Array(MAX_RECIPIENTS)
      .fill(0)
      .map((_, index) => ({ address: KEY_A, percentage: 100 / MAX_RECIPIENTS }));
    const errors = validateMultiRecipientStreamBody(validBody({ recipients }));
    expect(errors).toEqual([]);
  });

  it("accepts both supported tokens", () => {
    expect(validateMultiRecipientStreamBody(validBody({ token: "XLM" }))).toEqual([]);
    expect(validateMultiRecipientStreamBody(validBody({ token: "USDC" }))).toEqual([]);
  });
});

// ── Validator: recipient cap ─────────────────────────────────────────────────

describe("validateMultiRecipientStreamBody — recipient cap", () => {
  const recipients = (count: number) =>
    new Array(count)
      .fill(0)
      .map((_, index) => ({
        address: KEY_A,
        percentage: index === count - 1 ? 100 - (count - 1) * (100 / count) : 100 / count,
      }));

  it(`rejects ${MAX_RECIPIENTS + 1} recipients with TOO_MANY_RECIPIENTS`, () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: recipients(MAX_RECIPIENTS + 1) }),
    );
    expect(codesFor(errors, "recipients")).toContain("TOO_MANY_RECIPIENTS");
  });

  it("still reports per-recipient problems alongside the cap violation", () => {
    const list = recipients(MAX_RECIPIENTS + 1);
    list[3].address = "not-a-valid-address";
    const errors = validateMultiRecipientStreamBody(validBody({ recipients: list }));
    expect(codesFor(errors, "recipients")).toContain("TOO_MANY_RECIPIENTS");
    expect(codesFor(errors, "recipients.3.address")).toContain(
      "INVALID_RECIPIENT_ADDRESS",
    );
  });

  it("names the cap limit in the message so integrators can self-serve", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: recipients(MAX_RECIPIENTS + 1) }),
    );
    const cap = errors.find((e) => e.code === "TOO_MANY_RECIPIENTS");
    expect(cap?.message).toContain(`at most ${MAX_RECIPIENTS} recipients`);
    expect(MAX_RECIPIENTS).toBe(20);
  });

  it("does not flag the allocation sum when the cap is exceeded", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: recipients(MAX_RECIPIENTS + 1) }),
    );
    expect(codesFor(errors, "recipients")).not.toContain("ALLOCATION_MISMATCH");
  });
});

// ── Validator: allocation ────────────────────────────────────────────────────

describe("validateMultiRecipientStreamBody — allocation", () => {
  it("rejects percentages that do not sum to 100", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({
        recipients: [
          { address: KEY_A, percentage: 50 },
          { address: EMAIL_A, percentage: 40 },
        ],
      }),
    );
    expect(codesFor(errors, "recipients")).toContain("ALLOCATION_MISMATCH");
  });

  it("reports the received total in the ALLOCATION_MISMATCH message", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({
        recipients: [
          { address: KEY_A, percentage: 50 },
          { address: EMAIL_A, percentage: 40 },
        ],
      }),
    );
    const mismatch = errors.find((e) => e.code === "ALLOCATION_MISMATCH");
    expect(mismatch?.message).toContain("90.0000");
  });

  it("rejects a percentage above 100", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: [{ address: KEY_A, percentage: 100.5 }] }),
    );
    expect(codesFor(errors, "recipients.0.percentage")).toContain(
      "PERCENTAGE_OUT_OF_RANGE",
    );
  });

  it("rejects a negative percentage", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({
        recipients: [
          { address: KEY_A, percentage: -1 },
          { address: EMAIL_A, percentage: 101 },
        ],
      }),
    );
    expect(codesFor(errors, "recipients.0.percentage")).toContain(
      "PERCENTAGE_OUT_OF_RANGE",
    );
  });

  it("rejects more than 4 decimal places of precision", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: [{ address: KEY_A, percentage: 99.999999 }] }),
    );
    expect(codesFor(errors, "recipients.0.percentage")).toContain(
      "PERCENTAGE_PRECISION_EXCEEDED",
    );
  });

  it("rejects a non-numeric percentage", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: [{ address: KEY_A, percentage: "50" as unknown as number }] }),
    );
    expect(codesFor(errors, "recipients.0.percentage")).toContain("MISSING_FIELD");
  });

  it("rejects an echoed amount that disagrees with percentage x totalAmount", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({
        recipients: [
          { address: KEY_A, percentage: 50, amount: 4999 },
          { address: EMAIL_A, percentage: 50, amount: 5000 },
        ],
      }),
    );
    expect(codesFor(errors, "recipients.0.amount")).toContain("AMOUNT_MISMATCH");
  });

  it("accepts an echoed amount that differs only by 4-decimal rounding", () => {
    // What a client that displays amounts to 4 decimals would send.
    const errors = validateMultiRecipientStreamBody(
      validBody({
        totalAmount: 1000,
        recipients: [
          { address: KEY_A, percentage: 33.3333, amount: 333.333 },
          { address: EMAIL_A, percentage: 33.3333, amount: 333.333 },
          { address: KEY_A, percentage: 33.3334, amount: 333.334 },
        ],
      }),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a negative echoed amount", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: [{ address: KEY_A, percentage: 100, amount: -1 }] }),
    );
    expect(codesFor(errors, "recipients.0.amount")).toContain("NEGATIVE_AMOUNT");
  });
});

// ── Validator: recipients list shape ─────────────────────────────────────────

describe("validateMultiRecipientStreamBody — recipients list", () => {
  it("rejects a missing recipients array", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: undefined as unknown as [] }),
    );
    expect(codesFor(errors, "recipients")).toContain("MISSING_FIELD");
  });

  it("rejects an empty recipients array", () => {
    const errors = validateMultiRecipientStreamBody(validBody({ recipients: [] }));
    expect(codesFor(errors, "recipients")).toContain("EMPTY_RECIPIENTS");
  });

  it("rejects a non-object recipient entry", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: ["nope" as unknown as { address: string; percentage: number }] }),
    );
    expect(codesFor(errors, "recipients.0.address")).toContain("INVALID_RECIPIENT");
  });

  it("rejects a blank address", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ recipients: [{ address: "   ", percentage: 100 }] }),
    );
    expect(codesFor(errors, "recipients.0.address")).toContain("MISSING_FIELD");
  });
});

// ── Validator: top-level fields ──────────────────────────────────────────────

describe("validateMultiRecipientStreamBody — top-level fields", () => {
  it("rejects a non-object body", () => {
    for (const body of [null, 42, "string", []]) {
      const errors = validateMultiRecipientStreamBody(body);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ field: "body", code: "INVALID_BODY" });
    }
  });

  it("requires a name", () => {
    const errors = validateMultiRecipientStreamBody(validBody({ name: "  " }));
    expect(codesFor(errors, "name")).toContain("MISSING_FIELD");
  });

  it("caps the name length", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ name: "x".repeat(121) }),
    );
    expect(codesFor(errors, "name")).toContain("NAME_TOO_LONG");
  });

  it("rejects an unsupported token", () => {
    const errors = validateMultiRecipientStreamBody(validBody({ token: "USDT" }));
    expect(codesFor(errors, "token")).toContain("UNSUPPORTED_TOKEN");
  });

  it("rejects a zero or negative totalAmount", () => {
    expect(codesFor(validateMultiRecipientStreamBody(validBody({ totalAmount: 0 })), "totalAmount"))
      .toContain("NON_POSITIVE_TOTAL");
    expect(codesFor(validateMultiRecipientStreamBody(validBody({ totalAmount: -5 })), "totalAmount"))
      .toContain("NON_POSITIVE_TOTAL");
  });

  it("rejects a non-numeric totalAmount", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ totalAmount: "1000" as unknown as number }),
    );
    expect(codesFor(errors, "totalAmount")).toContain("MISSING_FIELD");
  });

  it("rejects an unparseable timestamp", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ startTime: "not-a-date" }),
    );
    expect(codesFor(errors, "startTime")).toContain("INVALID_TIMESTAMP");
  });

  it("rejects an endTime that is not after startTime", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ endTime: "2026-01-01T00:00:00.000Z" }),
    );
    expect(codesFor(errors, "endTime")).toContain("INVALID_TIME_RANGE");
  });

  it("rejects an endTime equal to startTime", () => {
    const errors = validateMultiRecipientStreamBody(
      validBody({ endTime: "2026-09-01T09:00:00.000Z" }),
    );
    expect(codesFor(errors, "endTime")).toContain("INVALID_TIME_RANGE");
  });

  it("collects every violation rather than stopping at the first", () => {
    const errors = validateMultiRecipientStreamBody({});
    const fields = errors.map((e) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining(["name", "token", "totalAmount", "startTime", "endTime", "recipients"]),
    );
  });
});
