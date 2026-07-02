export type RateInterval =
  | "second"
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export type FormatStreamingRateOptions = {
  /** Asset symbol used when the raw rate has no explicit asset. */
  asset?: string;
  /** Source cadence used when the raw rate has no explicit "/ interval" suffix. */
  sourceInterval?: string;
  /** Locale passed through to Intl.NumberFormat. */
  locale?: Intl.LocalesArgument;
};

type ParsedRate = {
  amount: number;
  asset?: string;
  interval?: RateInterval;
};

const DEFAULT_ASSET = "XLM";
const SIGNIFICANT_DIGITS = 4;
const MIN_SUBUNIT_FRACTION_DIGITS = 2;

const DECIMAL_PATTERN = /^[+]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const RATE_PATTERN =
  /^\s*([+]?(?:\d+(?:\.\d+)?|\.\d+))\s*([A-Za-z][A-Za-z0-9_-]*)?\s*(?:\/|per)\s*([A-Za-z]+)\s*$/i;

const INTERVAL_SECONDS: Record<RateInterval, number> = {
  day: 86_400,
  hour: 3_600,
  minute: 60,
  month: 2_592_000,
  second: 1,
  week: 604_800,
  year: 31_536_000,
};

const HUMAN_INTERVALS: Array<{ interval: Extract<RateInterval, "hour" | "day" | "week">; seconds: number }> = [
  { interval: "hour", seconds: INTERVAL_SECONDS.hour },
  { interval: "day", seconds: INTERVAL_SECONDS.day },
  { interval: "week", seconds: INTERVAL_SECONDS.week },
];

const INTERVAL_ALIASES: Record<string, RateInterval> = {
  d: "day",
  day: "day",
  days: "day",
  h: "hour",
  hr: "hour",
  hrs: "hour",
  hour: "hour",
  hours: "hour",
  m: "minute",
  min: "minute",
  mins: "minute",
  minute: "minute",
  minutes: "minute",
  mo: "month",
  month: "month",
  months: "month",
  s: "second",
  sec: "second",
  secs: "second",
  second: "second",
  seconds: "second",
  w: "week",
  wk: "week",
  wks: "week",
  week: "week",
  weeks: "week",
  y: "year",
  yr: "year",
  yrs: "year",
  year: "year",
  years: "year",
};

function normalizeInterval(input?: string): RateInterval | undefined {
  if (!input) return undefined;
  const normalized = input.trim().toLowerCase();
  return INTERVAL_ALIASES[normalized];
}

function parseRate(rawRate: string): ParsedRate | null {
  const trimmed = rawRate.trim();
  const unitMatch = RATE_PATTERN.exec(trimmed);

  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    if (!Number.isFinite(amount)) return null;

    return {
      amount,
      asset: unitMatch[2],
      interval: normalizeInterval(unitMatch[3]),
    };
  }

  if (!DECIMAL_PATTERN.test(trimmed)) {
    return null;
  }

  const amount = Number(trimmed);
  return Number.isFinite(amount) ? { amount } : null;
}

function roundToSignificantDigits(value: number): number {
  if (value === 0) return 0;

  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (SIGNIFICANT_DIGITS - magnitude - 1);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function significantFractionDigits(value: number): number {
  if (value === 0) return 0;

  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  return Math.max(0, SIGNIFICANT_DIGITS - magnitude - 1);
}

function displayFractionDigits(value: number): number {
  const rounded = roundToSignificantDigits(value);
  const maximumFractionDigits = Math.min(
    8,
    Math.max(
      significantFractionDigits(rounded),
      Math.abs(rounded) > 0 && Math.abs(rounded) < 1 ? MIN_SUBUNIT_FRACTION_DIGITS : 0,
    ),
  );

  if (maximumFractionDigits === 0) {
    return 0;
  }

  const minimumFractionDigits =
    Math.abs(rounded) > 0 && Math.abs(rounded) < 1 ? MIN_SUBUNIT_FRACTION_DIGITS : 0;
  const fixed = rounded.toFixed(maximumFractionDigits);
  const fraction = fixed.split(".")[1] ?? "";
  const trimmed = fraction.replace(/0+$/, "");

  return Math.max(minimumFractionDigits, trimmed.length);
}

function formatAmount(value: number, locale?: Intl.LocalesArgument): string {
  const rounded = roundToSignificantDigits(value);
  const fractionDigits = displayFractionDigits(rounded);

  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
    useGrouping: false,
  }).format(rounded);
}

function chooseHumanInterval(perSecond: number): (typeof HUMAN_INTERVALS)[number] {
  const readableInterval = HUMAN_INTERVALS.find(({ seconds }) => Math.abs(perSecond * seconds) >= 0.01);
  return readableInterval ?? HUMAN_INTERVALS[HUMAN_INTERVALS.length - 1];
}

function formatRateParts(amount: number, asset: string, interval: RateInterval, locale?: Intl.LocalesArgument): string {
  return `${formatAmount(amount, locale)} ${asset} / ${interval}`;
}

/**
 * Formats a stream rate for compact display in stream rows.
 *
 * The API can expose rates either as already formatted strings
 * ("120 XLM / month") or as raw decimals plus a separate cadence. Raw
 * second/minute cadences are converted into the first readable human unit
 * among hour, day, and week. Other cadences are normalized without changing
 * their meaning.
 */
export function formatStreamingRate(
  rawRate: string,
  options: FormatStreamingRateOptions = {},
): string {
  const parsed = parseRate(rawRate);
  if (!parsed) {
    return rawRate;
  }

  const asset = parsed.asset ?? options.asset?.trim() ?? DEFAULT_ASSET;
  const sourceInterval = parsed.interval ?? normalizeInterval(options.sourceInterval) ?? "second";

  if (sourceInterval === "second" || sourceInterval === "minute") {
    const perSecond = parsed.amount / INTERVAL_SECONDS[sourceInterval];
    const displayInterval = chooseHumanInterval(perSecond);
    return formatRateParts(
      perSecond * displayInterval.seconds,
      asset,
      displayInterval.interval,
      options.locale,
    );
  }

  return formatRateParts(parsed.amount, asset, sourceInterval, options.locale);
}
