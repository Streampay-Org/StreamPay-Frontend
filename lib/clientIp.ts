export interface ResolveClientIpOptions {
  trustedProxyHops?: number;
}

function expandIPv6(ip: string): string[] | null {
  const ipv4MappedMatch = ip.match(/^(?:::(?:ffff(?::0{1,4})?:)?)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch) {
    return null;
  }

  if (!/^[0-9a-fA-F:]+$/.test(ip)) {
    return null;
  }

  const parts = ip.split('::');
  if (parts.length > 2) {
    return null;
  }

  let leftHextets: string[] = [];
  let rightHextets: string[] = [];

  if (parts[0]) {
    leftHextets = parts[0].split(':').filter(Boolean);
  }
  if (parts.length === 2 && parts[1]) {
    rightHextets = parts[1].split(':').filter(Boolean);
  }

  const totalHextets = leftHextets.length + rightHextets.length;
  if (parts.length === 1 && totalHextets !== 8) {
    return null;
  }
  if (parts.length === 2 && totalHextets >= 8) {
    return null;
  }

  const missingZeros = parts.length === 2 ? 8 - totalHextets : 0;
  const zeroHextets = Array(missingZeros).fill('0000');

  const allHextets = [
    ...leftHextets.map((h) => h.padStart(4, '0').toLowerCase()),
    ...zeroHextets,
    ...rightHextets.map((h) => h.padStart(4, '0').toLowerCase()),
  ];

  if (allHextets.length !== 8) {
    return null;
  }

  for (const h of allHextets) {
    if (!/^[0-9a-f]{4}$/.test(h)) {
      return null;
    }
  }

  return allHextets;
}

export function normaliseIp(rawIp: string): string {
  let cleaned = rawIp.trim();
  if (!cleaned) return 'unknown';

  if (cleaned.startsWith('[')) {
    const closingIdx = cleaned.indexOf(']');
    if (closingIdx !== -1) {
      cleaned = cleaned.substring(1, closingIdx);
    }
  } else if (cleaned.includes(':')) {
    const ipv4PortMatch = cleaned.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
    if (ipv4PortMatch) {
      cleaned = ipv4PortMatch[1];
    }
  }

  const mappedMatch = cleaned.match(/^(?:::(?:ffff(?::0{1,4})?:)?)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedMatch) {
    return mappedMatch[1];
  }

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(cleaned)) {
    return cleaned;
  }

  const hextets = expandIPv6(cleaned);
  if (hextets) {
    const prefix = hextets.slice(0, 4).join(':');
    return prefix + '::/64';
  }

  return cleaned || 'unknown';
}

export type HeaderSource =
  | Headers
  | Map<string, string>
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null | undefined };

function getHeaderValue(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;

  const lowerName = name.toLowerCase();

  if (headers instanceof Map) {
    for (const [k, v] of headers.entries()) {
      if (k.toLowerCase() === lowerName) {
        return typeof v === 'string' ? v : null;
      }
    }
    return null;
  }

  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(name);
    if (val !== null && val !== undefined) return val;
    const lowerVal = (headers as Headers).get(lowerName);
    return lowerVal ?? null;
  }

  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowerName) {
        if (Array.isArray(v)) return v[0] ?? null;
        return typeof v === 'string' ? v : null;
      }
    }
  }

  return null;
}

export function resolveClientIp(
  headers: HeaderSource,
  options: ResolveClientIpOptions = {}
): string {
  const trustProxy = process.env.TRUST_PROXY;

  if (trustProxy === 'vercel') {
    const realIp = getHeaderValue(headers, 'x-real-ip');
    if (realIp && realIp.trim().length > 0) {
      return normaliseIp(realIp);
    }
  }

  const forwardedFor = getHeaderValue(headers, 'x-forwarded-for');
  if (forwardedFor && forwardedFor.trim().length > 0) {
    const entries = forwardedFor
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (entries.length > 0) {
      const hops = options.trustedProxyHops ?? 1;
      const targetIndex = entries.length - hops;
      const selectedIndex = targetIndex >= 0 ? targetIndex : 0;
      const rawSelected = entries[selectedIndex];
      if (rawSelected) {
        return normaliseIp(rawSelected);
      }
    }
  }

  const fallbackRealIp = getHeaderValue(headers, 'x-real-ip');
  if (fallbackRealIp && fallbackRealIp.trim().length > 0) {
    return normaliseIp(fallbackRealIp);
  }

  return 'unknown';
}
