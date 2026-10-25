import dns from "node:dns";
import net from "node:net";

export class UnsafeUrlError extends Error {
  readonly code = "UNSAFE_ENDPOINT_URL";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface OutboundUrlOptions {
  allowHttp?: boolean;
  dnsLookup?: DnsLookupFn;
}

export interface SafeOutboundUrlResult {
  url: URL;
  pinnedAddress: string;
}

/** Allowed ports for outbound webhooks */
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/**
 * Checks if an IPv4 address (as a 32-bit unsigned number) falls in private/restricted ranges.
 *
 * Blocked ranges:
 * - 0.0.0.0/8 (RFC 1122 Current network)
 * - 10.0.0.0/8 (RFC 1918 Private)
 * - 100.64.0.0/10 (RFC 6598 Shared Address Space / CGNAT)
 * - 127.0.0.0/8 (RFC 1122 Loopback)
 * - 169.254.0.0/16 (RFC 3927 Link-Local / Cloud Metadata)
 * - 172.16.0.0/12 (RFC 1918 Private)
 * - 192.0.0.0/24 (RFC 6890 IETF Protocol Assignments)
 * - 192.0.2.0/24 (RFC 5737 Documentation TEST-NET-1)
 * - 192.88.99.0/24 (RFC 7526 6to4 Relay Anycast)
 * - 192.168.0.0/16 (RFC 1918 Private)
 * - 198.18.0.0/15 (RFC 2544 Benchmarking)
 * - 198.51.100.0/24 (RFC 5737 Documentation TEST-NET-2)
 * - 203.0.113.0/24 (RFC 5737 Documentation TEST-NET-3)
 * - 224.0.0.0/4 (RFC 5771 Multicast)
 * - 240.0.0.0/4 (RFC 1112 Reserved / Class E & Broadcast)
 */
export function isPrivateOrRestrictedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const octets = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (octets.some((o) => o === -1)) return true;

  const num = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];

  // 0.0.0.0/8
  if ((num >>> 24) === 0) return true;
  // 10.0.0.0/8
  if ((num >>> 24) === 10) return true;
  // 100.64.0.0/10 (100.01xxxxxx) -> (num >>> 22) === (100 << 2) + 1 = 401
  if ((num >>> 22) === 0b01100100_01) return true;
  // 127.0.0.0/8
  if ((num >>> 24) === 127) return true;
  // 169.254.0.0/16
  if ((num >>> 16) === ((169 << 8) | 254)) return true;
  // 172.16.0.0/12 (172.0001xxxx) -> (num >>> 20) === (172 << 4) | 1 = 2753
  if ((num >>> 20) === ((172 << 4) | 1)) return true;
  // 192.0.0.0/24
  if ((num >>> 8) === ((192 << 16) | 0)) return true;
  // 192.0.2.0/24
  if ((num >>> 8) === ((192 << 16) | 2)) return true;
  // 192.88.99.0/24
  if ((num >>> 8) === ((192 << 16) | (88 << 8) | 99)) return true;
  // 192.168.0.0/16
  if ((num >>> 16) === ((192 << 8) | 168)) return true;
  // 198.18.0.0/15
  if ((num >>> 17) === ((198 << 7) | (18 >> 1))) return true;
  // 198.51.100.0/24
  if ((num >>> 8) === ((198 << 16) | (51 << 8) | 100)) return true;
  // 203.0.113.0/24
  if ((num >>> 8) === ((203 << 16) | (0 << 8) | 113)) return true;
  // 224.0.0.0/4 Multicast
  if ((num >>> 28) === 0b1110) return true;
  // 240.0.0.0/4 Reserved / Broadcast
  if ((num >>> 28) === 0b1111) return true;

  return false;
}

/**
 * Checks if an IPv6 address falls in private/restricted ranges.
 * Handles IPv4-mapped IPv6 (::ffff:10.0.0.1) as well.
 *
 * Blocked IPv6 ranges:
 * - ::/128 (Unspecified)
 * - ::1/128 (RFC 4291 Loopback)
 * - ::ffff:0:0/96 (IPv4-mapped - inspects mapped IPv4 address)
 * - 64:ff9b::/96 (RFC 6052 IPv4/IPv6 translation)
 * - 100::/64 (RFC 6666 Discard-only prefix)
 * - 2001:db8::/32 (RFC 3849 Documentation)
 * - fc00::/7 (RFC 4193 Unique Local Address / ULA)
 * - fe80::/10 (RFC 4291 Link-Local Unicast)
 * - ff00::/8 (RFC 4291 Multicast)
 */
export function isPrivateOrRestrictedIpv6(ip: string): boolean {
  let cleanIp = ip.toLowerCase();
  if (cleanIp.startsWith("[") && cleanIp.endsWith("]")) {
    cleanIp = cleanIp.slice(1, -1);
  }

  const ipv4MappedPrefix = "::ffff:";
  if (cleanIp.startsWith(ipv4MappedPrefix)) {
    const rest = cleanIp.slice(ipv4MappedPrefix.length);
    if (net.isIPv4(rest)) {
      return isPrivateOrRestrictedIpv4(rest);
    }
  }

  const isIpv4AtEnd = cleanIp.includes(".");
  let ipv4Part = "";
  if (isIpv4AtEnd) {
    const lastColon = cleanIp.lastIndexOf(":");
    ipv4Part = cleanIp.slice(lastColon + 1);
    cleanIp = cleanIp.slice(0, lastColon);
    if (!net.isIPv4(ipv4Part)) {
      return true;
    }
  }

  const doubleColonCount = (cleanIp.match(/::/g) || []).length;
  if (doubleColonCount > 1) return true;

  let chunks: string[] = [];
  if (cleanIp.includes("::")) {
    const [left, right] = cleanIp.split("::");
    const leftChunks = left ? left.split(":") : [];
    const rightChunks = right ? right.split(":") : [];
    const targetLength = isIpv4AtEnd ? 6 : 8;
    const missing = targetLength - (leftChunks.length + rightChunks.length);
    if (missing < 0) return true;
    chunks = [...leftChunks, ...Array(missing).fill("0"), ...rightChunks];
  } else {
    chunks = cleanIp ? cleanIp.split(":") : [];
  }

  if (isIpv4AtEnd) {
    const [o1, o2, o3, o4] = ipv4Part.split(".").map(Number);
    const w1 = ((o1 << 8) | o2).toString(16);
    const w2 = ((o3 << 8) | o4).toString(16);
    chunks.push(w1, w2);
  }

  if (chunks.length !== 8) return true;

  const words = chunks.map((c) => parseInt(c || "0", 16));
  if (words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) return true;

  // ::/128 Unspecified
  if (words.every((w) => w === 0)) return true;
  // ::1/128 Loopback
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // ::ffff:0:0/96
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const ipv4FromWords = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateOrRestrictedIpv4(ipv4FromWords);
  }
  // 64:ff9b::/96
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const ipv4FromWords = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateOrRestrictedIpv4(ipv4FromWords);
  }
  // 100::/64 Discard prefix
  if (words[0] === 0x100 && words.slice(1, 4).every((w) => w === 0)) return true;
  // 2001:db8::/32 Documentation
  if (words[0] === 0x2001 && words[1] === 0xdb8) return true;
  // fc00::/7 ULA (first byte 0xfc or 0xfd -> words[0] & 0xfe00 === 0xfc00)
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 Link-Local (words[0] & 0xffc0 === 0xfe80)
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 Multicast (words[0] & 0xff00 === 0xff00)
  if ((words[0] & 0xff00) === 0xff00) return true;

  return false;
}

export function isPrivateOrRestrictedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateOrRestrictedIpv4(ip);
  }
  if (net.isIPv6(ip)) {
    return isPrivateOrRestrictedIpv6(ip);
  }
  return true;
}

/**
 * Validates that an outbound webhook URL meets SSRF safety standards:
 * - Scheme must be https: in production; http: is allowed only when NODE_ENV !== "production" and host is not private.
 * - Rejects credentials (user:pass@).
 * - Restricts port to 443, 8443 (or 80 when http is permitted).
 * - Rejects private, loopback, link-local, multicast, and cloud metadata IP addresses.
 * - Resolves hostname via DNS (dns.promises.lookup with all: true) and rejects if any address is private.
 * - Returns the pinned address for the request to mitigate DNS rebinding.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  options: OutboundUrlOptions = {},
): Promise<SafeOutboundUrlResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    throw new UnsafeUrlError("URL must be a non-empty string.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL format.");
  }

  // Reject userinfo
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError("URL must not contain credentials (userinfo).");
  }

  const isProd = process.env.NODE_ENV === "production";
  const allowHttp = options.allowHttp ?? !isProd;

  if (parsed.protocol === "http:") {
    if (isProd || !allowHttp) {
      throw new UnsafeUrlError("HTTP is not allowed in production; HTTPS is required.");
    }
  } else if (parsed.protocol === "https:") {
    // Allowed
  } else {
    throw new UnsafeUrlError(`Unsupported protocol '${parsed.protocol}'. Only HTTPS (or HTTP in dev) is allowed.`);
  }

  // Check port
  const port = parsed.port;
  if (parsed.protocol === "https:") {
    if (!ALLOWED_PORTS.has(port)) {
      throw new UnsafeUrlError(`Port '${port}' is not permitted for outbound webhooks.`);
    }
  } else if (parsed.protocol === "http:") {
    if (port !== "" && port !== "80") {
      throw new UnsafeUrlError(`Port '${port}' is not permitted for outbound webhooks.`);
    }
  }

  // Hostname handling
  let hostname = parsed.hostname;
  if (!hostname) {
    throw new UnsafeUrlError("URL host is missing.");
  }

  // Strip brackets if IPv6
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  // If host is an IP literal
  if (net.isIP(hostname)) {
    if (isPrivateOrRestrictedIp(hostname)) {
      throw new UnsafeUrlError(`Host '${hostname}' resolves to a private or restricted IP address.`);
    }
    return { url: parsed, pinnedAddress: hostname };
  }

  // Otherwise, resolve DNS
  const lookupFn: DnsLookupFn =
    options.dnsLookup ??
    (async (host: string, opt: { all: true }) => {
      return await dns.promises.lookup(host, opt);
    });

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch (err) {
    throw new UnsafeUrlError(`DNS resolution failed for host '${hostname}': ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!addresses || addresses.length === 0) {
    throw new UnsafeUrlError(`DNS resolution returned no addresses for host '${hostname}'.`);
  }

  for (const entry of addresses) {
    if (isPrivateOrRestrictedIp(entry.address)) {
      throw new UnsafeUrlError(`Host '${hostname}' resolves to a private or restricted IP address (${entry.address}).`);
    }
  }

  const pinnedAddress = addresses[0].address;
  return {
    url: parsed,
    pinnedAddress,
  };
}
