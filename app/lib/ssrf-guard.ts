/**
 * SSRF guard for outbound webhook targets (#1727).
 *
 * Blocks private, loopback, link-local and cloud-metadata destinations at
 * URL level. DNS-level pinning is runtime-dependent (no synchronous DNS in
 * edge runtimes), so a fetch-time egress stub remains the belt-and-braces
 * defence; this guard stops the obvious bypass classes:
 *   - IP literals in private / loopback / link-local ranges (v4 + v6)
 *   - localhost, *.local, *.internal and cloud metadata hostnames
 *   - non-http(s) schemes and embedded credentials
 */
const BLOCKED_HOST_SUFFIXES = [
  ".local", ".internal", ".lan", ".home.arpa", ".localhost",
];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.goog", "metadata"]);

function v4Blocked(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a] = parts;
  return a === 0 || a === 10 || a === 127 || parts[0] === 169 && parts[1] === 254 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function v6Blocked(host: string): boolean {
  const h = host.replace(/%.*$/, "").toLowerCase();
  return (
    h === "::" || h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") ||
    h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") ||
    h.startsWith("::ffff:127.") || h.startsWith("::ffff:10.") ||
    h.startsWith("::ffff:192.168.") || h.startsWith("::ffff:169.254.")
  );
}

export function isSafePublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return false;

  if (host.includes(":")) return !v6Blocked(host);
  if (/^[0-9.]+$/.test(host)) return !v4Blocked(host);
  return true;
}
