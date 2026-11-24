export const DEFAULT_SITE_URL = "http://localhost:3000";

/**
 * Returns the canonical site origin (protocol + host, no trailing slash)
 * from `NEXT_PUBLIC_SITE_URL`, falling back safely to `DEFAULT_SITE_URL`
 * if unset, malformed, or using a non-HTTPS protocol in production.
 */
export function getSiteUrl(
  rawUrl: string | undefined = process.env.NEXT_PUBLIC_SITE_URL,
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return DEFAULT_SITE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEFAULT_SITE_URL;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return DEFAULT_SITE_URL;
  }

  if (nodeEnv === "production" && parsed.protocol !== "https:") {
    return DEFAULT_SITE_URL;
  }

  return parsed.origin;
}

export function getSiteUrlObject(
  rawUrl?: string,
  nodeEnv?: string
): URL {
  return new URL(getSiteUrl(rawUrl, nodeEnv));
}
