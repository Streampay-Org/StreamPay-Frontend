export const SUPPORTED_LOCALES = ["en", "pseudo"] as const;

export type Locale = (typeof SUPPORTED_LOCALES[Number]);

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE_NAME = "locale";

export type CookieValue = string | undefined;

export interface CookieSource {
  get(name: string): { value?: string } | undefined;
}

export interface HeaderSource {
  get(name: string): string | null;
}

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  if (!value) return false;
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Parse an Accept-Language header and return the first supported locale.
 * Handles quality values and region subtags (e.g. "fr-CA" -> "fr").
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const entries = header
    .split(",")
    .map((part) => {
      const [segment, q = "1"] = part.trim().split(";");
      const tag = segment.trim().toLowerCase();
      const quality = Number.parseFloat(q.replace(/q\s*=\s*/, ""));
      return { tag, quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of entries) {
    const primary = entry.tag.split("-")[0];
    if (isSupportedLocale(entry.tag)) return entry.tag;
    if (isSupportedLocale(primary)) return primary;
  }

  return null;
}

/**
 * Resolve the active locale from the cookie, then the Accept-Language header,
 * then the default.
 */
export function resolveLocale(cookies: CookieSource, headers: HeaderSource): Locale {
  const cookieValue = cookies.get(LOCALE_COOKIE_NAME)?.value;
  if (isSupportedLocale(cookieValue)) return cookieValue;

  const fromHeader = parseAcceptLanguage(headers.get("accept-language"));
  if (fromHeader) return fromHeader;

  return DEFAULT_LOCALE;
}

export function getDirection(locale: Locale): "ltr" | "rtl" {
  // No RTL-native locales are supported yet; the hook exists for future locales.
  void locale;
  return "ltr";
}

/** Alias used by the root layout for the `html dir` attribute. */
export const getLocaleDir = getDirection;
