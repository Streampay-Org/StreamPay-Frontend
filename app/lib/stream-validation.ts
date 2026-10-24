/**
 * Stream Validation Module
 *
 * Shared request-body validation for POST /api/streams handlers (v1 & v2).
 * Ensures recipient, rate, and schedule meet Stellar network requirements
 * before the stream is persisted.
 *
 * All validators return structured error arrays so the calling route can
 * return 422 VALIDATION_ERROR with per-field details.
 */

import { isValidStellarPublicKey } from "@/app/lib/wallet-link";
import { STELLAR_MAX_I64, STROOPS_SCALE } from "@/app/lib/amount";
import { z } from "zod";
import type { StreamStatus } from "@/app/types/openapi";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Schedule values supported by the schedule engine.
 * @see app/lib/schedules.ts — PayoutInterval type
 */
export const SUPPORTED_SCHEDULES = [
  "second",
  "minute",
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

export type SupportedSchedule = (typeof SUPPORTED_SCHEDULES)[number];

/** Maximum decimal places allowed for rate (Stellar supports 7). */
const MAX_DECIMAL_PRECISION = 7;

/** Regex for a non-negative decimal number (whole or fractional). */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Normalises a decimal string to canonical form:
 * - Trims whitespace
 * - Strips leading zeros (preserving "0" if zero whole part)
 * - Strips trailing fractional zeros and trailing dot
 * E.g., "0050.5000" -> "50.5", "00.120" -> "0.12", "0100" -> "100"
 */
export function canonicaliseRate(rate: string): string {
  const trimmed = rate.trim();
  const [wholePart = "0", fractionPart] = trimmed.split(".");
  const canonicalWhole = wholePart.replace(/^0+(?=\d)/, "");
  if (fractionPart !== undefined) {
    const canonicalFraction = fractionPart.replace(/0+$/, "");
    if (canonicalFraction.length > 0) {
      return `${canonicalWhole}.${canonicalFraction}`;
    }
  }
  return canonicalWhole;
}

/**
 * Parses a decimal string rate into stroops using bigint math.
 * Assumes the string matches DECIMAL_PATTERN and has at most 7 fractional decimals.
 */
export function rateToStroops(rate: string): bigint {
  const trimmed = rate.trim();
  const [wholePart = "0", fractionPart = ""] = trimmed.split(".");
  const whole = BigInt(wholePart);
  const paddedFraction = `${fractionPart}0000000`.slice(0, 7);
  const fraction = BigInt(paddedFraction);
  return whole * STROOPS_SCALE + fraction;
}

export interface NormalisedCreateStreamInput {
  recipient: string;
  rate: string;
  schedule: SupportedSchedule;
  token?: string;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  code: string;
  message: string;
  alias?: string;
}

export interface CreateStreamBody {
  recipient: string;
  rate: string;
  schedule: string;
  token?: string;
  totalAmount?: string;
  startTime?: string;
  endTime?: string;
}

/**
 * Zod schema for validating the request body for `PATCH /api/v2/streams/[id]`.
 *
 * - `description`: Optional, up to 280 characters.
 * - `webhook_url`: Optional, must be a valid URL.
 * - `tags`: Optional, array of up to 10 strings, each 1-50 characters.
 *
 * The schema is `strict`, meaning any unknown fields will be rejected.
 */
export const patchStreamSchema = z
  .object({
    description: z.string().min(1, "Description cannot be empty.").max(280).optional(),
    webhook_url: z.string().url("Must be a valid URL.").optional(),
    tags: z
      .array(
        z
          .string()
          .min(1, "Tag cannot be empty.")
          .max(50, "Tag cannot exceed 50 characters."),
      )
      .max(10, "Cannot have more than 10 tags.")
      .optional(),
  })
  .strict("Unknown fields are not allowed.");


// ── Validator ──────────────────────────────────────────────────────────────

function zodIssuesToErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => {
    const params = (issue as { params?: { code?: unknown; alias?: unknown } }).params;
    const err: ValidationError = {
      field: issue.path.join(".") || "body",
      code:
        typeof params?.code === "string" ? params.code : issue.code.toUpperCase(),
      message: issue.message,
    };
    if (typeof params?.alias === "string") {
      err.alias = params.alias;
    }
    return err;
  });
}

/**
 * Zod schema for the POST /api/streams body.
 *
 * The field rules and error codes are the long-standing contract of
 * `validateCreateStreamBody`; each violation is emitted as a custom issue
 * carrying its code in `params`, so callers see identical errors.
 */
export const createStreamSchema = z
  .record(z.unknown())
  .superRefine((body, ctx) => {
    const fail = (path: string, code: string, message: string, alias?: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path],
        message,
        params: { code, ...(alias ? { alias } : {}) },
      });

    const recipient = body.recipient;
    if (typeof recipient !== "string" || recipient.trim().length === 0) {
      fail(
        "recipient",
        "MISSING_FIELD",
        "recipient is required and must be a non-empty string.",
      );
    } else if (!isValidStellarPublicKey(recipient.trim())) {
      fail(
        "recipient",
        "INVALID_STELLAR_KEY",
        "recipient must be a valid Stellar public key (56-char string starting with G).",
      );
    }

    const rate = body.rate;
    if (typeof rate !== "string" || rate.trim().length === 0) {
      fail("rate", "MISSING_FIELD", "rate is required and must be a non-empty string.");
    } else {
      const trimmed = rate.trim();

      if (!DECIMAL_PATTERN.test(trimmed)) {
        fail(
          "rate",
          "INVALID_RATE_FORMAT",
          "rate must be a positive decimal number (e.g. 100 or 50.5).",
        );
      } else {
        const [wholePart = "", fractionPart = ""] = trimmed.split(".");
        const isAllZeros = /^0+$/.test(wholePart) && (fractionPart.length === 0 || /^0+$/.test(fractionPart));

        if (isAllZeros) {
          fail("rate", "RATE_NOT_POSITIVE", "rate must be greater than zero.", "NEGATIVE_RATE");
        }

        if (fractionPart.length > MAX_DECIMAL_PRECISION) {
          fail(
            "rate",
            "DECIMAL_PRECISION_EXCEEDED",
            `rate supports at most ${MAX_DECIMAL_PRECISION} decimal places.`,
          );
        } else if (!isAllZeros) {
          const stroops = rateToStroops(trimmed);
          if (stroops > STELLAR_MAX_I64) {
            fail("rate", "RATE_TOO_LARGE", "rate exceeds Stellar int64 stroop bounds.");
          }
        }
      }
    }

    const schedule = body.schedule;
    if (typeof schedule !== "string" || schedule.trim().length === 0) {
      fail(
        "schedule",
        "MISSING_FIELD",
        "schedule is required and must be a non-empty string.",
      );
    } else if (
      !SUPPORTED_SCHEDULES.includes(
        schedule.trim().toLowerCase() as SupportedSchedule,
      )
    ) {
      fail(
        "schedule",
        "INVALID_SCHEDULE",
        `schedule must be one of: ${SUPPORTED_SCHEDULES.join(", ")}.`,
      );
    }

    const token = body.token;
    if (token !== undefined && token !== null && typeof token !== "string") {
      fail("token", "INVALID_TOKEN_FORMAT", "token must be a string if provided.");
    }

    if (body.totalAmount !== undefined && (
      typeof body.totalAmount !== "string" ||
      !/^\d+$/.test(body.totalAmount) ||
      BigInt(body.totalAmount) === 0n ||
      BigInt(body.totalAmount) > (1n << 127n) - 1n
    )) {
      fail("totalAmount", "INVALID_TOTAL_AMOUNT", "totalAmount must be a positive raw i128 string.");
    }

    if (body.startTime !== undefined || body.endTime !== undefined) {
      const start = typeof body.startTime === "string" ? Date.parse(body.startTime) : NaN;
      const end = typeof body.endTime === "string" ? Date.parse(body.endTime) : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        fail("endTime", "INVALID_VESTING_WINDOW", "startTime and endTime must be valid dates with endTime after startTime.");
      }
    }
  });

/**
 * Validates the request body for POST /api/streams.
 *
 * Returns an array of field-level errors. An empty array means the body is
 * valid (though the caller still needs to handle token allowlisting etc.).
 */
export function validateCreateStreamBody(
  body: unknown,
): ValidationError[] {
  const result = createStreamSchema.safeParse(body);
  return result.success ? [] : zodIssuesToErrors(result.error);
}
export type ParseCreateStreamResult =
  | { success: true; data: NormalisedCreateStreamInput }
  | { success: false; errors: ValidationError[] };

/**
 * Validates and parses the request body for stream creation.
 * Returns normalised fields on success:
 * - recipient: trimmed Stellar address
 * - rate: canonical decimal form (no leading zeros, no trailing fractional zeros)
 * - schedule: trimmed lowercased SupportedSchedule
 * - token: optional string
 */
export function parseCreateStreamBody(
  body: unknown,
): ParseCreateStreamResult {
  const errors = validateCreateStreamBody(body);
  if (errors.length > 0) {
    return { success: false, errors };
  }

  const b = body as Record<string, unknown>;
  const recipient = String(b.recipient).trim();
  const rate = canonicaliseRate(String(b.rate));
  const schedule = String(b.schedule).trim().toLowerCase() as SupportedSchedule;
  const token = typeof b.token === "string" ? b.token : undefined;

  return {
    success: true,
    data: {
      recipient,
      rate,
      schedule,
      ...(token !== undefined ? { token } : {}),
    },
  };
}

// ── GET /api/streams query ─────────────────────────────────────────────────

export const STREAM_STATUSES = [
  "draft",
  "active",
  "paused",
  "ended",
  "withdrawn",
  "cancelled",
] as const satisfies readonly StreamStatus[];

/**
 * Zod schema for the GET /api/streams query params. Values arrive as URL
 * strings; `limit` is returned as a number. Unknown params are ignored by
 * the caller, and cursor decoding stays a separate semantic check
 * (INVALID_CURSOR) in the route.
 */
export const listStreamsQuerySchema = z.object({
  limit: z
    .string()
    .superRefine((value, ctx) => {
      const fail = (message: string) =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          params: { code: "INVALID_LIMIT" },
        });

      if (!/^\d+$/.test(value)) {
        fail("limit must be a positive integer.");
        return;
      }
      const parsed = Number(value);
      if (parsed < 1 || parsed > 100) {
        fail("limit must be between 1 and 100.");
      }
    })
    .transform(Number)
    .optional(),
  status: z
    .string()
    .superRefine((value, ctx) => {
      if (!(STREAM_STATUSES as readonly string[]).includes(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `status must be one of: ${STREAM_STATUSES.join(", ")}.`,
          params: { code: "INVALID_STATUS" },
        });
      }
    })
    .transform((value) => value as StreamStatus)
    .optional(),
  cursor: z
    .string()
    .superRefine((value, ctx) => {
      if (value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "cursor must not be empty.",
          params: { code: "INVALID_CURSOR" },
        });
      }
    })
    .optional(),
});

export type ListStreamsQuery = z.infer<typeof listStreamsQuerySchema>;

/**
 * Validates the query params for GET /api/streams.
 *
 * Returns field-level errors plus the parsed values on success.
 */
export function validateListStreamsQuery(query: Record<string, unknown>): {
  errors: ValidationError[];
  values: ListStreamsQuery;
} {
  const result = listStreamsQuerySchema.safeParse(query);
  if (result.success) {
    return { errors: [], values: result.data };
  }
  return { errors: zodIssuesToErrors(result.error), values: {} };
}

/**
 * Validates the request body for PATCH /api/v2/streams/[id] using Zod.
 *
 * @param body The raw request body.
 * @returns An array of `ValidationError`. An empty array means success.
 */
export function validatePatchStreamBody(
  body: unknown,
): ValidationError[] {
  const result = patchStreamSchema.safeParse(body);

  if (result.success) {
    return [];
  }

  return result.error.issues.map((issue) => ({
    field: issue.path.join(".") || "body",
    code: issue.code.toUpperCase(),
    message: issue.message,
  }));
}
