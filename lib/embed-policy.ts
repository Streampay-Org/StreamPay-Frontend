const DEFAULT_FRAME_ANCESTORS = "'none'";

/**
 * Parse and validate the origins allowed to embed StreamPay widgets.
 *
 * Only explicit HTTPS origins are accepted. Paths, credentials, query strings,
 * fragments, wildcard hosts, and malformed URLs are rejected.
 */
export function parseEmbedAllowedOrigins(
  value: string | undefined,
): string[] {
  if (!value?.trim()) return [];

  const origins = new Set<string>();

  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;

    try {
      const url = new URL(candidate);

      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        candidate.includes("*")
      ) {
        continue;
      }

      origins.add(url.origin);
    } catch {
      // Ignore malformed entries. Invalid configuration never broadens access.
    }
  }

  return [...origins];
}

/**
 * Build the framing policy. An empty or invalid allowlist denies all framing.
 */
export function buildEmbedCsp(
  allowedOrigins: string[],
): string {
  const ancestors = allowedOrigins.length
    ? allowedOrigins.join(" ")
    : DEFAULT_FRAME_ANCESTORS;

  return `frame-ancestors ${ancestors}`;
}

/**
 * Resolve the policy directly from the runtime environment.
 */
export function getEmbedCsp(): string {
  const origins = parseEmbedAllowedOrigins(
    process.env.EMBED_ALLOWED_ORIGINS,
  );

  return buildEmbedCsp(origins);
}
