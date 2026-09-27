/**
 * multi-recipient.ts
 *
 * Single source of truth for the multi-recipient (fan-out) stream contract
 * shared by `POST /api/v2/streams/multi` and the `/streams/new/multi`
 * wizard. Both sides import this module so the client pre-check and the
 * server-side enforcement can never drift apart, and so the rules documented
 * in `docs/api/multi-recipient-stream.md` are the rules that are enforced.
 *
 * The module is intentionally free of Node-only imports so it can be bundled
 * into a client component.
 *
 * @see app/api/v2/streams/multi/route.ts  — server enforcement
 * @see app/streams/new/multi.tsx          — UI pre-check + payload builder
 * @see docs/api/multi-recipient-stream.md — integrator-facing documentation
 */

import { isValidStellarPublicKey } from "./stellar-address";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of recipients allowed in a single fan-out stream.
 *
 * Enforced by the API (`TOO_MANY_RECIPIENTS`, 422) and mirrored by the UI
 * (the "Add recipient" control is disabled at the cap). A fan-out is written
 * as one stream per recipient, so this bound also caps the number of escrows
 * a single request can create.
 */
export const MAX_RECIPIENTS = 20;

/** Every allocation must add up to this total. */
export const ALLOCATION_TARGET_PERCENTAGE = 100;

/**
 * Absolute tolerance (in percentage points) allowed when summing
 * allocations. Percentages are exchanged with at most
 * {@link PERCENTAGE_DECIMALS} decimals, and an equal split across
 * `MAX_RECIPIENTS` legs can leave up to `20 x 5e-5 = 1e-3` of accumulated
 * rounding drift, so a bare `=== 100` check would reject legitimate requests.
 */
export const PERCENTAGE_SUM_TOLERANCE = 0.001;

/** Decimal places accepted (and emitted) for allocation percentages. */
export const PERCENTAGE_DECIMALS = 4;

/**
 * Decimal places for token amounts. Stellar moves amounts as i128 values with
 * 7 decimals of precision, so 7 is the finest granularity a leg can express.
 */
export const AMOUNT_DECIMALS = 7;

/**
 * Tolerance when a client echoes a per-recipient `amount` back to the API.
 * The wizard rounds its display values to 4 decimals, so a client-supplied
 * amount may differ from the server-derived amount by at most 5e-5.
 */
export const AMOUNT_ECHO_TOLERANCE = 1e-4;

/** Tokens a fan-out can be denominated in. */
export const SUPPORTED_MULTI_RECIPIENT_TOKENS = ["XLM", "USDC"] as const;

export type MultiRecipientToken = (typeof SUPPORTED_MULTI_RECIPIENT_TOKENS)[number];

/** Maximum accepted length of a human-readable stream name. */
export const MAX_STREAM_NAME_LENGTH = 120;

/** Upper bound on a recipient address (RFC 5321 maximum email length). */
export const MAX_RECIPIENT_ADDRESS_LENGTH = 254;

// ── Types ────────────────────────────────────────────────────────────────────

/** A field-level validation failure, matching `app/lib/stream-validation.ts`. */
export interface MultiRecipientValidationError {
  field: string;
  code: string;
  message: string;
}

/** One recipient as it arrives in the request body. */
export interface MultiRecipientInput {
  address: string;
  percentage: number;
  /** Optional echo of the derived amount. The server recomputes it. */
  amount?: number;
}

/** The validated, normalised request body. */
export interface MultiRecipientStreamRequest {
  name: string;
  token: string;
  totalAmount: number;
  startTime: string;
  endTime: string;
  recipients: MultiRecipientInput[];
}

/** One fully resolved allocation leg. */
export interface ResolvedAllocation {
  address: string;
  percentage: number;
  amount: number;
}

/** Minimal shape the wizard keeps for each recipient row. */
export interface WizardRecipient {
  address: string;
  percentage: number;
  amount: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Primitive checks ─────────────────────────────────────────────────────────

/** True when `value` is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A recipient address is either a registered email address or a Stellar
 * ed25519 public key. Anything else (a typo, a truncated key, a raw memo tag)
 * is rejected before any stream is written.
 *
 * Implemented via `app/lib/stellar-address` rather than
 * `app/lib/wallet-link` because the latter imports Node's `crypto` and cannot
 * be bundled into a client component. Both share the same Strkey decoder.
 */
export function isValidRecipientAddress(address: string): boolean {
  if (typeof address !== "string") return false;

  const trimmed = address.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_RECIPIENT_ADDRESS_LENGTH) {
    return false;
  }

  if (trimmed.includes("@")) {
    return EMAIL_PATTERN.test(trimmed);
  }

  return isValidStellarPublicKey(trimmed);
}

/** True when `value` has no more than `decimals` decimal places. */
export function hasAtMostDecimals(value: number, decimals: number): boolean {
  const scaled = value * 10 ** decimals;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * True when the allocations add up to 100% within
 * {@link PERCENTAGE_SUM_TOLERANCE}.
 */
export function allocationSumsToTarget(percentages: number[]): boolean {
  if (percentages.length === 0) return false;
  const total = percentages.reduce((sum, p) => sum + p, 0);
  return Math.abs(total - ALLOCATION_TARGET_PERCENTAGE) < PERCENTAGE_SUM_TOLERANCE;
}

/**
 * Parse a timestamp that may arrive as an ISO-8601 string or as epoch
 * milliseconds. Returns `null` when the value is unusable.
 *
 * `datetime-local` inputs (what the wizard binds to) produce
 * `2026-09-01T09:00`, which `Date.parse` reads as local time; the conversion
 * to UTC happens once, on the server, so the wizard and the API agree on the
 * requested window.
 */
function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── Amount derivation ────────────────────────────────────────────────────────

/**
 * Amount owed to a single recipient for a single percentage, rounded to the
 * token's 7-decimal precision.
 */
export function deriveSingleAmount(totalAmount: number, percentage: number): number {
  const scale = 10 ** AMOUNT_DECIMALS;
  return Math.round((percentage / ALLOCATION_TARGET_PERCENTAGE) * totalAmount * scale) / scale;
}

/**
 * Split `totalAmount` across `percentages`, in raw `10 ** AMOUNT_DECIMALS`
 * units, so the legs sum back to the total exactly.
 *
 * The last leg absorbs the rounding remainder rather than every leg being
 * rounded independently — otherwise a 3-way split of 1000 would allocate
 * 999.999999 units and silently strand dust in escrow.
 */
export function deriveAllocationAmounts(
  totalAmount: number,
  percentages: number[],
): number[] {
  const scale = 10 ** AMOUNT_DECIMALS;
  const totalUnits = Math.round(totalAmount * scale);
  const amounts: number[] = [];
  let allocatedUnits = 0;

  percentages.forEach((percentage, index) => {
    if (index === percentages.length - 1) {
      amounts.push((totalUnits - allocatedUnits) / scale);
      return;
    }
    const units = Math.round((percentage / ALLOCATION_TARGET_PERCENTAGE) * totalUnits);
    allocatedUnits += units;
    amounts.push(units / scale);
  });

  return amounts;
}

/**
 * Pair each recipient with its authoritative amount. Percentages are
 * authoritative; any client-supplied `amount` is treated as an echo.
 */
export function resolveAllocations(
  totalAmount: number,
  recipients: MultiRecipientInput[],
): ResolvedAllocation[] {
  const amounts = deriveAllocationAmounts(
    totalAmount,
    recipients.map((r) => r.percentage),
  );

  return recipients.map((recipient, index) => ({
    address: recipient.address.trim(),
    percentage: recipient.percentage,
    amount: amounts[index],
  }));
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Render a percentage as a fixed-precision decimal string. */
export function formatPercentage(value: number): string {
  return value.toFixed(PERCENTAGE_DECIMALS);
}

/** Render a token amount as a fixed-precision decimal string. */
export function formatAmount(value: number): string {
  return value.toFixed(AMOUNT_DECIMALS);
}

/** Convert a validated `startTime` / `endTime` to an ISO-8601 UTC string. */
export function toIsoUtc(value: string): string {
  return new Date(value).toISOString();
}

// ── Payload builder (shared by the UI and the documentation examples) ───────

/**
 * Build the exact JSON body posted to `POST /api/v2/streams/multi`.
 *
 * Percentages are authoritative: the `amount` of each leg is recomputed with
 * the same rounding the server applies, so a wizard row whose display value
 * was rounded to 4 decimals can never produce a payload the API would reject
 * as `AMOUNT_MISMATCH`.
 *
 * Exported so the documented request example and the wizard cannot diverge:
 * `docs/__tests__/multi-recipient-doc.test.ts` asserts that the example in
 * `docs/api/multi-recipient-stream.md` is identical to the output of this
 * function.
 */
export function buildMultiRecipientPayload(input: {
  name: string;
  token: string;
  totalAmount: number;
  startTime: string;
  endTime: string;
  recipients: WizardRecipient[];
}): MultiRecipientStreamRequest {
  const resolved = resolveAllocations(
    input.totalAmount,
    input.recipients.map((r) => ({ address: r.address, percentage: r.percentage })),
  );

  return {
    name: input.name.trim(),
    token: input.token,
    totalAmount: input.totalAmount,
    startTime: input.startTime,
    endTime: input.endTime,
    recipients: resolved.map((allocation) => ({
      address: allocation.address,
      percentage: allocation.percentage,
      amount: allocation.amount,
    })),
  };
}

// ── Validator ────────────────────────────────────────────────────────────────

/**
 * Validate a `POST /api/v2/streams/multi` body.
 *
 * Returns every violation found (not just the first) so the wizard can
 * surface all bad rows in one pass. An empty array means the body is
 * acceptable.
 */
export function validateMultiRecipientStreamBody(
  body: unknown,
): MultiRecipientValidationError[] {
  const errors: MultiRecipientValidationError[] = [];

  const fail = (field: string, code: string, message: string) => {
    errors.push({ field, code, message });
  };

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    fail("body", "INVALID_BODY", "Request body must be a JSON object.");
    return errors;
  }

  const record = body as Record<string, unknown>;

  // ── name ────────────────────────────────────────────────────────────────
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    fail("name", "MISSING_FIELD", "name is required and must be a non-empty string.");
  } else if (record.name.trim().length > MAX_STREAM_NAME_LENGTH) {
    fail(
      "name",
      "NAME_TOO_LONG",
      `name must be at most ${MAX_STREAM_NAME_LENGTH} characters.`,
    );
  }

  // ── token ───────────────────────────────────────────────────────────────
  if (typeof record.token !== "string" || record.token.trim().length === 0) {
    fail("token", "MISSING_FIELD", "token is required and must be a non-empty string.");
  } else if (
    !(SUPPORTED_MULTI_RECIPIENT_TOKENS as readonly string[]).includes(
      record.token.trim(),
    )
  ) {
    fail(
      "token",
      "UNSUPPORTED_TOKEN",
      `token must be one of: ${SUPPORTED_MULTI_RECIPIENT_TOKENS.join(", ")}.`,
    );
  }

  // ── totalAmount ─────────────────────────────────────────────────────────
  const totalAmount = isFiniteNumber(record.totalAmount) ? record.totalAmount : null;

  if (totalAmount === null) {
    fail("totalAmount", "MISSING_FIELD", "totalAmount is required and must be a number.");
  } else if (totalAmount <= 0) {
    fail("totalAmount", "NON_POSITIVE_TOTAL", "totalAmount must be greater than zero.");
  }

  // ── startTime / endTime ─────────────────────────────────────────────────
  const startMs = parseTimestamp(record.startTime);
  const endMs = parseTimestamp(record.endTime);

  if (startMs === null) {
    fail(
      "startTime",
      "INVALID_TIMESTAMP",
      "startTime is required and must be an ISO-8601 date-time string.",
    );
  }
  if (endMs === null) {
    fail(
      "endTime",
      "INVALID_TIMESTAMP",
      "endTime is required and must be an ISO-8601 date-time string.",
    );
  }
  if (startMs !== null && endMs !== null && endMs <= startMs) {
    fail("endTime", "INVALID_TIME_RANGE", "endTime must be strictly after startTime.");
  }

  // ── recipients ──────────────────────────────────────────────────────────
  const recipients = record.recipients;

  if (!Array.isArray(recipients)) {
    fail(
      "recipients",
      "MISSING_FIELD",
      "recipients is required and must be an array of recipient objects.",
    );
    return errors;
  }

  if (recipients.length === 0) {
    fail("recipients", "EMPTY_RECIPIENTS", "At least one recipient is required.");
    return errors;
  }

  if (recipients.length > MAX_RECIPIENTS) {
    fail(
      "recipients",
      "TOO_MANY_RECIPIENTS",
      `A fan-out stream supports at most ${MAX_RECIPIENTS} recipients; received ${recipients.length}.`,
    );
    // Only the first MAX_RECIPIENTS legs can ever be written, so validating
    // the overflow would report errors the caller cannot act on.
    recipients.slice(0, MAX_RECIPIENTS).forEach((raw, index) =>
      validateRecipient(raw, index, totalAmount, fail),
    );
    return errors;
  }

  recipients.forEach((raw, index) =>
    validateRecipient(raw, index, totalAmount, fail),
  );

  const percentages = recipients
    .map((raw) => (raw as MultiRecipientInput)?.percentage)
    .filter((p): p is number => isFiniteNumber(p));

  if (!allocationSumsToTarget(percentages)) {
    const total = percentages.reduce((sum, p) => sum + p, 0);
    fail(
      "recipients",
      "ALLOCATION_MISMATCH",
      `Allocated percentages must sum to ${ALLOCATION_TARGET_PERCENTAGE}; received ${formatPercentage(total)}.`,
    );
  }

  return errors;
}

/** Validate a single recipient entry and append any violations to `fail`. */
function validateRecipient(
  raw: unknown,
  index: number,
  totalAmount: number | null,
  fail: (field: string, code: string, message: string) => void,
): void {
  const field = `recipients.${index}`;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${field}.address`, "INVALID_RECIPIENT", "Each recipient must be an object.");
    return;
  }

  const recipient = raw as MultiRecipientInput;

  if (typeof recipient.address !== "string" || recipient.address.trim().length === 0) {
    fail(
      `${field}.address`,
      "MISSING_FIELD",
      "address is required and must be a non-empty string.",
    );
  } else if (!isValidRecipientAddress(recipient.address)) {
    fail(
      `${field}.address`,
      "INVALID_RECIPIENT_ADDRESS",
      "address must be a valid Stellar public key or a registered email address.",
    );
  }

  if (!isFiniteNumber(recipient.percentage)) {
    fail(
      `${field}.percentage`,
      "MISSING_FIELD",
      "percentage is required and must be a number.",
    );
    return;
  }

  const percentage = recipient.percentage;

  if (percentage < 0 || percentage > ALLOCATION_TARGET_PERCENTAGE) {
    fail(
      `${field}.percentage`,
      "PERCENTAGE_OUT_OF_RANGE",
      `percentage must be between 0 and ${ALLOCATION_TARGET_PERCENTAGE}.`,
    );
  } else if (!hasAtMostDecimals(percentage, PERCENTAGE_DECIMALS)) {
    fail(
      `${field}.percentage`,
      "PERCENTAGE_PRECISION_EXCEEDED",
      `percentage supports at most ${PERCENTAGE_DECIMALS} decimal places.`,
    );
  }

  // The amount is optional. When supplied it is treated as an echo of the
  // server-derived value and must agree with it — a disagreeing echo means
  // the client and the server compute different splits, so it is rejected
  // rather than silently overwritten.
  if (recipient.amount === undefined || recipient.amount === null) return;

  if (!isFiniteNumber(recipient.amount)) {
    fail(`${field}.amount`, "INVALID_AMOUNT", "amount must be a number when provided.");
    return;
  }

  if (recipient.amount < 0) {
    fail(`${field}.amount`, "NEGATIVE_AMOUNT", "amount must not be negative.");
    return;
  }

  if (totalAmount === null || totalAmount <= 0) return;

  const derived = deriveSingleAmount(totalAmount, percentage);
  if (Math.abs(recipient.amount - derived) > AMOUNT_ECHO_TOLERANCE) {
    fail(
      `${field}.amount`,
      "AMOUNT_MISMATCH",
      `amount must equal percentage x totalAmount (${formatAmount(derived)}); the server recomputes this value.`,
    );
  }
}
