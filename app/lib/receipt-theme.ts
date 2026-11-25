/**
 * Per-recipient receipt customisation.
 *
 * Lets a recipient brand the receipt they receive with their own logo,
 * accent colour and a short thank-you message. The theme is fully
 * validated and normalised here so that UI components can render it
 * without re-checking untrusted input.
 */

/** Raw, possibly-untrusted customisation supplied by a recipient. */
export type ReceiptThemeInput = {
  /** Absolute https URL of a logo image. */
  logoUrl?: string | null;
  /** Hex accent colour, e.g. "#1f6feb". */
  accentColor?: string | null;
  /** Short message shown on the receipt, e.g. "Thanks for your support!". */
  message?: string | null;
};

/** Validated, render-ready receipt theme. */
export type ReceiptTheme = {
  logoUrl?: string;
  accentColor: string;
  message?: string;
};

/** Default StreamPay brand accent used when a recipient sets none. */
export const DEFAULT_ACCENT_COLOR = "#1f6feb";

/** Messages longer than this are truncated to keep receipts tidy. */
export const MAX_MESSAGE_LENGTH = 140;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** True for a syntactically valid 3- or 6-digit hex colour. */
export function isValidAccentColor(value: string | null | undefined): boolean {
  return typeof value === "string" && HEX_COLOR.test(value.trim());
}

/**
 * Environment variable holding the comma-separated allowlist of hostnames
 * permitted for recipient receipt logo URLs.
 *
 * Supports exact hostnames (e.g. "cdn.example.com") and subdomain wildcards
 * (e.g. "*.example.com"). Matching is case-insensitive and performed against
 * the parsed URL hostname.
 *
 * Fail-closed: when unset or empty, no logo URLs are allowed.
 */
export const RECEIPT_LOGO_ALLOWED_HOSTS_ENV = "RECEIPT_LOGO_ALLOWED_HOSTS";

type AllowedHostRule =
  | { type: "exact"; host: string }
  | { type: "wildcard"; suffix: string };

function normalizeHostPattern(raw: string): AllowedHostRule | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const isWildcard = trimmed.startsWith("*.");
  const candidate = isWildcard ? trimmed.slice(2) : trimmed;

  if (
    !candidate ||
    candidate.includes("*") ||
    candidate.includes("/") ||
    candidate.includes(":")
  ) {
    return null;
  }

  try {
    const normalized = new URL(`https://${candidate}`).hostname.replace(/\.$/, "");
    if (!normalized) return null;
    if (isWildcard) {
      return { type: "wildcard", suffix: `.${normalized}` };
    }
    return { type: "exact", host: normalized };
  } catch {
    return null;
  }
}

/**
 * Reads and parses the `RECEIPT_LOGO_ALLOWED_HOSTS` environment variable.
 * Returns an empty array when unset or empty (fail-closed).
 */
export function getAllowedLogoHosts(
  rawValue: string | undefined = process.env[RECEIPT_LOGO_ALLOWED_HOSTS_ENV],
): AllowedHostRule[] {
  if (!rawValue) return [];
  const rules: AllowedHostRule[] = [];
  for (const entry of rawValue.split(",")) {
    const rule = normalizeHostPattern(entry);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isHostAllowed(hostname: string, rules: AllowedHostRule[]): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalizedHost) return false;

  for (const rule of rules) {
    if (rule.type === "exact" && normalizedHost === rule.host) {
      return true;
    }
    if (
      rule.type === "wildcard" &&
      normalizedHost.length > rule.suffix.length &&
      normalizedHost.endsWith(rule.suffix)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True only for absolute https URLs without embedded credentials or
 * non-default ports whose hostname matches `RECEIPT_LOGO_ALLOWED_HOSTS`.
 *
 * Fail-closed: returns `false` when `RECEIPT_LOGO_ALLOWED_HOSTS` is unset
 * or empty so arbitrary third-party hosts cannot be used as tracking pixels.
 */
export function isSafeLogoUrl(
  value: string | null | undefined,
  rules = getAllowedLogoHosts(),
): boolean {
  if (typeof value !== "string" || !/^https:\/\//i.test(value.trim())) return false;

  if (rules.length === 0) return false;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    if (url.username !== "" || url.password !== "") return false;
    if (url.port !== "") return false;
    return isHostAllowed(url.hostname, rules);
  } catch {
    return false;
  }
}

/**
 * Normalise untrusted recipient input into a render-ready theme.
 * Invalid logo URLs and colours fall back to safe defaults, and the
 * message is trimmed and length-capped.
 */
export function normalizeReceiptTheme(
  input: ReceiptThemeInput = {},
  logoHosts = getAllowedLogoHosts(),
): ReceiptTheme {
  const theme: ReceiptTheme = {
    accentColor: isValidAccentColor(input.accentColor)
      ? input.accentColor!.trim().toLowerCase()
      : DEFAULT_ACCENT_COLOR,
  };

  if (isSafeLogoUrl(input.logoUrl, logoHosts)) {
    theme.logoUrl = new URL(input.logoUrl!.trim()).href;
  }

  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message) {
    theme.message =
      message.length > MAX_MESSAGE_LENGTH
        ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`
        : message;
  }

  return theme;
}

export function validateReceiptTheme(
  input: unknown,
  logoHosts = getAllowedLogoHosts(),
): Partial<Record<keyof ReceiptThemeInput | "body", string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { body: "Receipt theme must be a JSON object." };
  }

  const { accentColor, logoUrl, message } = input as Record<string, unknown>;
  const errors: Partial<Record<keyof ReceiptThemeInput, string>> = {};
  if (accentColor != null && (typeof accentColor !== "string" || !isValidAccentColor(accentColor))) {
    errors.accentColor = "Enter a 3- or 6-digit hex colour, such as #1f6feb.";
  }
  if (logoUrl != null && (
    typeof logoUrl !== "string" || (logoUrl.trim() && !isSafeLogoUrl(logoUrl, logoHosts))
  )) {
    errors.logoUrl = "Enter an HTTPS image URL from an approved host.";
  }
  if (message != null && (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH)) {
    errors.message = `Enter a message of at most ${MAX_MESSAGE_LENGTH} characters.`;
  }
  return errors;
}
