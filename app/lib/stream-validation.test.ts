/**
 * Tests for app/lib/stream-validation.ts
 *
 * Covers all validation scenarios for POST /api/streams body fields:
 * recipient, rate, schedule, and optional token.
 */

import fc from "fast-check";
import {
  validateCreateStreamBody,
  parseCreateStreamBody,
  canonicaliseRate,
  validateListStreamsQuery,
  validatePatchStreamBody,
  STREAM_STATUSES,
  SUPPORTED_SCHEDULES,
} from "./stream-validation";

const VALID_STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

// ── Happy path ─────────────────────────────────────────────────────────────

describe("validateCreateStreamBody", () => {
  it("returns no errors for a valid body with all required fields", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "month",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts rate with decimal places", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "50.5",
      schedule: "day",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts rate with 7 decimal places (Stellar max)", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "1.1234567",
      schedule: "hour",
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts all supported schedules", () => {
    for (const schedule of SUPPORTED_SCHEDULES) {
      const errors = validateCreateStreamBody({
        recipient: VALID_STELLAR_KEY,
        rate: "100",
        schedule,
      });
      expect(errors).toHaveLength(0);
    }
  });

  it("accepts optional token field", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "week",
      token: "USDC",
    });
    expect(errors).toHaveLength(0);
  });

  // ── recipient errors ─────────────────────────────────────────────────────

  it("returns error when recipient is missing", () => {
    const errors = validateCreateStreamBody({
      rate: "100",
      schedule: "month",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("recipient");
    expect(errors[0].code).toBe("MISSING_FIELD");
  });

  it("returns error when recipient is not a string", () => {
    const errors = validateCreateStreamBody({
      recipient: 123,
      rate: "100",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "recipient",
          code: "MISSING_FIELD",
        }),
      ]),
    );
  });

  it("returns error when recipient is empty string", () => {
    const errors = validateCreateStreamBody({
      recipient: "",
      rate: "100",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "recipient",
          code: "MISSING_FIELD",
        }),
      ]),
    );
  });

  it("returns error when recipient is not a valid Stellar key", () => {
    const errors = validateCreateStreamBody({
      recipient: "GABC123",
      rate: "100",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "recipient",
          code: "INVALID_STELLAR_KEY",
        }),
      ]),
    );
  });

  it("returns error when recipient is a short string", () => {
    const errors = validateCreateStreamBody({
      recipient: "not-a-valid-key",
      rate: "100",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "recipient",
          code: "INVALID_STELLAR_KEY",
        }),
      ]),
    );
  });

  // ── rate errors ──────────────────────────────────────────────────────────

  it("returns error when rate is missing", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      schedule: "month",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("rate");
    expect(errors[0].code).toBe("MISSING_FIELD");
  });

  it("returns error when rate is not a string", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: 100,
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "rate", code: "MISSING_FIELD" }),
      ]),
    );
  });

  it("returns error when rate is empty string", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "rate", code: "MISSING_FIELD" }),
      ]),
    );
  });

  it("returns error when rate is zero", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "0",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "rate", code: "RATE_NOT_POSITIVE", alias: "NEGATIVE_RATE" }),
      ]),
    );
  });

  it("returns error when rate is negative", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "-50",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "rate", code: "INVALID_RATE_FORMAT" }),
      ]),
    );
  });

  it("returns error when rate has too many decimal places", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "1.12345678",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "rate",
          code: "DECIMAL_PRECISION_EXCEEDED",
        }),
      ]),
    );
  });

  it("returns error when rate is not a number", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "abc",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "rate",
          code: "INVALID_RATE_FORMAT",
        }),
      ]),
    );
  });

  it("returns error when rate has multiple decimal points", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "50.5.5",
      schedule: "month",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "rate",
          code: "INVALID_RATE_FORMAT",
        }),
      ]),
    );
  });

  // ── schedule errors ──────────────────────────────────────────────────────

  it("returns error when schedule is missing", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("schedule");
    expect(errors[0].code).toBe("MISSING_FIELD");
  });

  it("returns error when schedule is not a string", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: 123,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "schedule",
          code: "MISSING_FIELD",
        }),
      ]),
    );
  });

  it("returns error when schedule is empty string", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "schedule",
          code: "MISSING_FIELD",
        }),
      ]),
    );
  });

  it("returns error when schedule is not in supported set", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "daily",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "schedule",
          code: "INVALID_SCHEDULE",
        }),
      ]),
    );
  });

  it("returns error for unknown schedule value", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "30 days",
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "schedule",
          code: "INVALID_SCHEDULE",
        }),
      ]),
    );
  });

  // ── token errors ─────────────────────────────────────────────────────────

  it("returns error when token is not a string", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "month",
      token: 123,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "token",
          code: "INVALID_TOKEN_FORMAT",
        }),
      ]),
    );
  });

  it("allows token to be null (will default to XLM)", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "month",
      token: null,
    });
    // null is explicitly allowed — route defaults to XLM
    const tokenErrors = errors.filter((e) => e.field === "token");
    expect(tokenErrors).toHaveLength(0);
  });

  it("allows token to be undefined", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "month",
    });
    const tokenErrors = errors.filter((e) => e.field === "token");
    expect(tokenErrors).toHaveLength(0);
  });

  // ── multiple errors ──────────────────────────────────────────────────────

  it("returns multiple errors when multiple fields are invalid", () => {
    const errors = validateCreateStreamBody({});
    expect(errors.length).toBeGreaterThanOrEqual(3);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("recipient");
    expect(fields).toContain("rate");
    expect(fields).toContain("schedule");
  });

  it("returns multiple field-level errors from different fields", () => {
    const errors = validateCreateStreamBody({
      recipient: "not-a-key",
      rate: "0",
      schedule: "unknown",
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("recipient");
    expect(fields).toContain("rate");
    expect(fields).toContain("schedule");
    const rateErrors = errors.filter((e) => e.field === "rate");
    expect(rateErrors.length).toBeGreaterThanOrEqual(1);
    expect(rateErrors[0].code).toBe("RATE_NOT_POSITIVE");
    expect(rateErrors[0].alias).toBe("NEGATIVE_RATE");
  });

  // ── whitespace handling ──────────────────────────────────────────────────

  it("trims whitespace from recipient before validating", () => {
    const errors = validateCreateStreamBody({
      recipient: `  ${VALID_STELLAR_KEY}  `,
      rate: "100",
      schedule: "month",
    });
    expect(errors).toHaveLength(0);
  });

  it("trims whitespace from schedule before validating", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "  month  ",
    });
    expect(errors).toHaveLength(0);
  });

  it("schedule is case-insensitive", () => {
    const errors = validateCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "MONTH",
    });
    expect(errors).toHaveLength(0);
  });
});

describe("validatePatchStreamBody", () => {
  it("returns no errors for a valid body with all fields", () => {
    const errors = validatePatchStreamBody({
      description: "Updated description",
      webhook_url: "https://example.com/webhook",
      tags: ["api", "v2"],
    });
    expect(errors).toHaveLength(0);
  });

  it("returns no errors for a valid partial body (description only)", () => {
    const errors = validatePatchStreamBody({
      description: "New description",
    });
    expect(errors).toHaveLength(0);
  });

  it("returns no errors for an empty body", () => {
    const errors = validatePatchStreamBody({});
    expect(errors).toHaveLength(0);
  });

  it("returns an error for unknown fields due to strict schema", () => {
    const errors = validatePatchStreamBody({
      description: "A valid field",
      unknown_field: "This should be rejected",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("UNRECOGNIZED_KEYS");
    expect(errors[0].message).toMatch(/Unknown fields are not allowed|Unrecognized key/i);
  });

  it("returns an error for an invalid webhook_url", () => {
    const errors = validatePatchStreamBody({
      webhook_url: "not-a-valid-url",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("webhook_url");
    expect(errors[0].message).toBe("Must be a valid URL.");
  });

  it("returns an error if tags is not an array", () => {
    const errors = validatePatchStreamBody({
      tags: "not-an-array",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("tags");
    expect(errors[0].message).toBe("Expected array, received string");
  });

  it("returns an error if a tag is not a string", () => {
    const errors = validatePatchStreamBody({
      tags: ["valid", 123],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("tags.1");
    expect(errors[0].message).toBe("Expected string, received number");
  });

  it("returns an error if tags array is too long", () => {
    const errors = validatePatchStreamBody({
      tags: Array.from({ length: 11 }, (_, i) => `tag${i}`),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("tags");
    expect(errors[0].message).toBe("Cannot have more than 10 tags.");
  });

  it("returns an error if a tag is too long", () => {
    const errors = validatePatchStreamBody({
      tags: ["a".repeat(51)],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("tags.0");
    expect(errors[0].message).toBe("Tag cannot exceed 50 characters.");
  });

  it("returns multiple errors for multiple invalid fields", () => {
    const errors = validatePatchStreamBody({
      webhook_url: "invalid",
      tags: [123],
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("webhook_url");
    expect(fields).toContain("tags.0");
  });

  it("returns an error for a non-object body", () => {
    const errors = validatePatchStreamBody("i-am-a-string");
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe('body');
    expect(errors[0].message).toBe('Expected object, received string');
  });
});

// ── GET /api/streams query ─────────────────────────────────────────────────

describe("validateListStreamsQuery", () => {
  it("returns no errors and parsed values for a valid query", () => {
    const { errors, values } = validateListStreamsQuery({
      limit: "25",
      status: "active",
      cursor: "abc",
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({ limit: 25, status: "active", cursor: "abc" });
  });

  it("returns no errors for an empty query", () => {
    const { errors, values } = validateListStreamsQuery({});
    expect(errors).toEqual([]);
    expect(values).toEqual({});
  });

  it("rejects a non-numeric limit", () => {
    const { errors } = validateListStreamsQuery({ limit: "abc" });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe("limit");
    expect(errors[0].code).toBe("INVALID_LIMIT");
  });

  it("rejects limits outside 1-100", () => {
    expect(validateListStreamsQuery({ limit: "0" }).errors.length).toBe(1);
    expect(validateListStreamsQuery({ limit: "101" }).errors.length).toBe(1);
    expect(validateListStreamsQuery({ limit: "100" }).errors).toEqual([]);
  });

  it("accepts every known stream status and rejects others", () => {
    for (const status of STREAM_STATUSES) {
      expect(validateListStreamsQuery({ status }).errors).toEqual([]);
    }
    const { errors } = validateListStreamsQuery({ status: "bogus" });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe("status");
    expect(errors[0].code).toBe("INVALID_STATUS");
  });

  it("rejects an empty cursor", () => {
    const { errors } = validateListStreamsQuery({ cursor: "" });
    expect(errors.length).toBe(1);
    expect(errors[0].field).toBe("cursor");
    expect(errors[0].code).toBe("INVALID_CURSOR");
  });
});

// ── Non-object bodies ──────────────────────────────────────────────────────

describe("validateCreateStreamBody non-object bodies", () => {
  it.each([null, [], "i-am-a-string", 42])(
    "returns a single body INVALID_TYPE error for %p",
    (body) => {
      const errors = validateCreateStreamBody(body);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("body");
      expect(errors[0].code).toBe("INVALID_TYPE");
    },
  );
});


// ── parseCreateStreamBody and Normalisation and Rate Capping ────────────────

describe("parseCreateStreamBody and normalisation rules", () => {
  it("Row 1: recipient with whitespace is parsed and normalised (trimmed)", () => {
    const res = parseCreateStreamBody({
      recipient: `  ${VALID_STELLAR_KEY}  `,
      rate: "100",
      schedule: "month",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.recipient).toBe(VALID_STELLAR_KEY);
    }
  });

  it("Row 2: schedule with mixed case is parsed and normalised (lowercased)", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "100",
      schedule: "Month",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.schedule).toBe("month");
    }
  });

  it("Row 3: rate with leading/trailing fractional zeros is canonicalised ('0050.5000' -> '50.5')", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "0050.5000",
      schedule: "month",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rate).toBe("50.5");
    }
  });

  it("canonicaliseRate handles edge cases properly", () => {
    expect(canonicaliseRate("00.120")).toBe("0.12");
    expect(canonicaliseRate("0100")).toBe("100");
    expect(canonicaliseRate("100.00")).toBe("100");
    expect(canonicaliseRate("0.0")).toBe("0");
    expect(canonicaliseRate("000")).toBe("0");
    expect(canonicaliseRate("   42.500   ")).toBe("42.5");
  });

  it("Row 4: rate exceeding STELLAR_MAX_I64 ('922337203685.4775808') returns 422 RATE_TOO_LARGE", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "922337203685.4775808",
      schedule: "month",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: "rate", code: "RATE_TOO_LARGE" }),
        ]),
      );
    }
  });

  it("Row 5: rate equal to STELLAR_MAX_I64 ('922337203685.4775807') is accepted", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "922337203685.4775807",
      schedule: "month",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.rate).toBe("922337203685.4775807");
    }
  });

  it("Row 6: rate '0' returns 422 RATE_NOT_POSITIVE with NEGATIVE_RATE alias", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "0",
      schedule: "month",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "rate",
            code: "RATE_NOT_POSITIVE",
            alias: "NEGATIVE_RATE",
          }),
        ]),
      );
    }
  });

  it("Row 7: rate with > 7 decimals ('1.12345678') returns 422 DECIMAL_PRECISION_EXCEEDED", () => {
    const res = parseCreateStreamBody({
      recipient: VALID_STELLAR_KEY,
      rate: "1.12345678",
      schedule: "month",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "rate",
            code: "DECIMAL_PRECISION_EXCEEDED",
          }),
        ]),
      );
    }
  });

  it("Row 8: fast-check property test for round-trip idempotence on canonicalised rates", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9223372036854775807n }),
        (stroops) => {
          const s = stroops.toString();
          let formatted: string;
          if (s.length <= 7) {
            formatted = "0." + s.padStart(7, "0");
          } else {
            formatted = s.slice(0, s.length - 7) + "." + s.slice(s.length - 7);
          }
          // canonicalise
          const canon = canonicaliseRate(formatted);
          // parseCreateStreamBody on canon should preserve canon
          const res = parseCreateStreamBody({
            recipient: VALID_STELLAR_KEY,
            rate: canon,
            schedule: "month",
          });
          expect(res.success).toBe(true);
          if (res.success) {
            expect(res.data.rate).toBe(canon);
            expect(canonicaliseRate(res.data.rate)).toBe(canon);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
