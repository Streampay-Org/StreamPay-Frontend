export const STROOPS_SCALE = 10_000_000n;
export const STELLAR_MAX_I64 = 9_223_372_036_854_775_807n;

export const SUPPORTED_ASSETS = ["XLM", "USDC"] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

export type ValidationError = {
  code:
    | "INVALID_AMOUNT_FORMAT"
    | "NEGATIVE_AMOUNT"
    | "DECIMAL_PRECISION_EXCEEDED"
    | "SUB_OPERATION_PRECISION"
    | "AMOUNT_OVERFLOW"
    | "UNSUPPORTED_ASSET"
    | "INVALID_DURATION"
    | "NEGATIVE_RATE";
  httpStatus: 400 | 422;
  message: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { error: ValidationError; ok: false };

export type StreamInterval = "day" | "week" | "month";

const INTERVAL_SECONDS: Record<StreamInterval, bigint> = {
  day: 86_400n,
  month: 2_592_000n,
  week: 604_800n,
};

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;

function validationError(
  httpStatus: ValidationError["httpStatus"],
  code: ValidationError["code"],
  message: string,
): ValidationResult<never> {
  return { error: { code, httpStatus, message }, ok: false };
}

function normalizeInput(input: string): string {
  return input.trim();
}

function isSupportedAsset(asset: string): asset is SupportedAsset {
  return SUPPORTED_ASSETS.includes(asset as SupportedAsset);
}

function normalizeDecimalString(stroops: bigint): string {
  const whole = stroops / STROOPS_SCALE;
  const fraction = (stroops % STROOPS_SCALE)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  if (fraction.length === 0) {
    return whole.toString();
  }

  return `${whole.toString()}.${fraction}`;
}

export class Amount {
  private constructor(
    public readonly asset: SupportedAsset,
    public readonly stroops: bigint,
  ) {}

  static parse(input: string, asset: string): ValidationResult<Amount> {
    if (!isSupportedAsset(asset)) {
      return validationError(
        422,
        "UNSUPPORTED_ASSET",
        `Unsupported asset "${asset}". Supported assets: ${SUPPORTED_ASSETS.join(", ")}.`,
      );
    }

    const normalized = normalizeInput(input);

    if (normalized.startsWith("-")) {
      return validationError(422, "NEGATIVE_AMOUNT", "Amount must be zero or greater.");
    }

    if (!AMOUNT_PATTERN.test(normalized)) {
      return validationError(400, "INVALID_AMOUNT_FORMAT", "Amount must be a plain decimal value.");
    }

    const [wholePart, fractionPart = ""] = normalized.split(".");

    if (fractionPart.length > 7) {
      return validationError(422, "DECIMAL_PRECISION_EXCEEDED", "Amount supports at most 7 decimal places.");
    }

    const whole = BigInt(wholePart);
    const paddedFraction = `${fractionPart}0000000`.slice(0, 7);
    const fraction = BigInt(paddedFraction);

    const stroops = whole * STROOPS_SCALE + fraction;

    if (stroops > STELLAR_MAX_I64) {
      return validationError(422, "AMOUNT_OVERFLOW", "Amount exceeds Stellar int64 bounds.");
    }

    return { ok: true, value: new Amount(asset, stroops) };
  }

  static fromStroops(stroops: bigint, asset: SupportedAsset): ValidationResult<Amount> {
    if (stroops < 0n) {
      return validationError(422, "NEGATIVE_AMOUNT", "Amount must be zero or greater.");
    }

    if (stroops > STELLAR_MAX_I64) {
      return validationError(422, "AMOUNT_OVERFLOW", "Amount exceeds Stellar int64 bounds.");
    }

    return { ok: true, value: new Amount(asset, stroops) };
  }

  toDecimalString(): string {
    return normalizeDecimalString(this.stroops);
  }
}

export type StreamRate = {
  amount: Amount;
  interval: StreamInterval;
};

export function createRate(
  amountInput: string,
  asset: string,
  interval: StreamInterval,
): ValidationResult<StreamRate> {
  const amountResult = Amount.parse(amountInput, asset);

  if (!amountResult.ok) {
    return amountResult;
  }

  return {
    ok: true,
    value: {
      amount: amountResult.value,
      interval,
    },
  };
}

export function formatRate(rate: StreamRate): string {
  return `${rate.amount.toDecimalString()} ${rate.amount.asset} / ${rate.interval}`;
}

export function deriveEscrowTotal(
  rate: StreamRate,
  durationSeconds: bigint,
): ValidationResult<Amount> {
  if (durationSeconds < 0n) {
    return validationError(422, "INVALID_DURATION", "Duration must be zero or greater.");
  }

  const denominator = INTERVAL_SECONDS[rate.interval];
  const numerator = rate.amount.stroops * durationSeconds;

  if (numerator > STELLAR_MAX_I64 * denominator) {
    return validationError(422, "AMOUNT_OVERFLOW", "Escrow total exceeds Stellar int64 bounds.");
  }

  if (numerator % denominator !== 0n) {
    return validationError(
      422,
      "SUB_OPERATION_PRECISION",
      "Duration produces fractional stroops and cannot be represented exactly.",
    );
  }

  const stroops = numerator / denominator;
  return Amount.fromStroops(stroops, rate.amount.asset);
}

/**
 * Parse a plain decimal amount string into an exact `bigint` stroop amount.
 *
 * This is the shared, precision-safe entry point for UI code that needs to
 * reason about amounts without going through an `Amount` instance (which is
 * asset-scoped). No `Number` arithmetic is used, so values above 2^53 stroops
 * keep their exact value.
 *
 * Rejects negative values, more than 7 decimal places and anything above
 * Stellar's int64 stroop maximum.
 */
export function parseStroops(input: string): ValidationResult<bigint> {
  const normalized = normalizeInput(input);

  if (normalized.length === 0) {
    return validationError(400, "INVALID_AMOUNT_FORMAT", "Amount must be a plain decimal value.");
  }

  if (normalized.startsWith("-")) {
    return validationError(422, "NEGATIVE_AMOUNT", "Amount must be zero or greater.");
  }

  if (!AMOUNT_PATTERN.test(normalized)) {
    return validationError(400, "INVALID_AMOUNT_FORMAT", "Amount must be a plain decimal value.");
  }

  const [wholePart, fractionPart = ""] = normalized.split(".");

  if (fractionPart.length > 7) {
    return validationError(
      422,
      "DECIMAL_PRECISION_EXCEEDED",
      "Amount supports at most 7 decimal places.",
    );
  }

  const whole = BigInt(wholePart);
  const paddedFraction = `${fractionPart}0000000`.slice(0, 7);
  const fraction = BigInt(paddedFraction);

  const stroops = whole * STROOPS_SCALE + fraction;

  if (stroops > STELLAR_MAX_I64) {
    return validationError(422, "AMOUNT_OVERFLOW", "Amount exceeds the Stellar maximum.");
  }

  return { ok: true, value: stroops };
}

/**
 * Format an exact stroop amount as a plain decimal string (no trailing zeros).
 *
 * @example
 *   formatStroops(98_500_000n) // "98.5"
 *   formatStroops(50_000_000n) // "50"
 */
export function formatStroops(stroops: bigint): string {
  return normalizeDecimalString(stroops);
}

export function parseDurationSeconds(input: string): ValidationResult<bigint> {
  const normalized = normalizeInput(input);

  if (!/^\d+$/.test(normalized)) {
    return validationError(400, "INVALID_DURATION", "Duration must be a whole number of seconds.");
  }

  const value = BigInt(normalized);

  if (value > STELLAR_MAX_I64) {
    return validationError(422, "AMOUNT_OVERFLOW", "Duration exceeds supported bounds.");
  }

  return { ok: true, value };
}

export const TEMPLATE_AMOUNT_PATTERN = /^\d{1,12}(?:\.\d{1,7})?$/;

export type TemplateAmountValidationResult =
  | { ok: true; value: string }
  | { ok: false; code: "INVALID_AMOUNT"; message: string };

/**
 * Validates and converts a template amount input into a canonical decimal string.
 *
 * Rules:
 * - Must be a decimal string matching `^\d{1,12}(\.\d{1,7})?$` or legacy numeric input.
 * - Greater than 0.
 * - At most the Stellar int64-stroop maximum (STELLAR_MAX_I64).
 * - For numeric input, rejects if precision would be lost (more than 7 decimals, scientific notation, etc.).
 */
export function parseTemplateAmount(input: unknown): TemplateAmountValidationResult {
  if (input === null || input === undefined || typeof input === "boolean") {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "amountPerInterval must be a positive decimal number with at most 7 decimal places.",
    };
  }

  let candidate: string;

  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) {
      return {
        ok: false,
        code: "INVALID_AMOUNT",
        message: "amountPerInterval must be a positive number.",
      };
    }

    const rawStr = input.toString();
    if (rawStr.includes("e") || rawStr.includes("E")) {
      return {
        ok: false,
        code: "INVALID_AMOUNT",
        message: "amountPerInterval must be a plain decimal without scientific notation.",
      };
    }

    candidate = rawStr;
  } else if (typeof input === "string") {
    candidate = input.trim();
  } else {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "amountPerInterval must be a string or number.",
    };
  }

  if (!TEMPLATE_AMOUNT_PATTERN.test(candidate)) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "amountPerInterval must be a positive decimal number with at most 7 decimal places.",
    };
  }

  const [wholePart, fractionPart = ""] = candidate.split(".");
  const paddedFraction = fractionPart.padEnd(7, "0");
  const stroops = BigInt(wholePart) * STROOPS_SCALE + BigInt(paddedFraction);

  if (stroops <= 0n) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "amountPerInterval must be greater than zero.",
    };
  }

  if (stroops > STELLAR_MAX_I64) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: "amountPerInterval exceeds maximum Stellar bounds.",
    };
  }

  return { ok: true, value: candidate };
}
