import { logger } from '../app/lib/logger';

/**
 * Normalizes the client IP address from request headers.
 * Following specification: x-forwarded-for (first hop), x-real-ip,
 * cf-connecting-ip, true-client-ip.
 *
 * @param headers - Request headers
 * @returns Normalized IP string, or "unknown"
 */
function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor) {
    // The first IP in the list is the client IP
    return forwardedFor.split(',')[0].trim().toLowerCase();
  }
  const xRealIp = headers.get('x-real-ip');
  if (xRealIp) return xRealIp.trim().toLowerCase();
  const cfConnectingIp = headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp.trim().toLowerCase();
  const trueClientIp = headers.get('true-client-ip');
  if (trueClientIp) return trueClientIp.trim().toLowerCase();

  return 'unknown';
}

export const REQUEST_FINGERPRINT_HEADER = 'x-request-fingerprint';
export const REQUEST_FINGERPRINT_AUDIT_ACTION = 'request.fingerprint.captured';

type AuditHookFn = (request: Request, fingerprint: string) => Promise<void> | void;
let activeAuditHook: AuditHookFn | null = null;

export function setRequestFingerprintAuditHook(hook: AuditHookFn | null): void {
  activeAuditHook = hook;
}

export function getRequestFingerprintFromHeaders(headers: Headers): string | null {
  return headers.get(REQUEST_FINGERPRINT_HEADER);
}

export function extractRequestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

/**
 * Normalizes request signals to generate a stable, non-volatile fingerprint.
 *
 * @param request - The incoming request
 * @returns SHA-256 hash string
 */

/** Pure-JS SHA-256 (hex) so this module runs on the Edge runtime (no node:crypto). */
function sha256Hex(input: string): string {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15],7) ^ rotr(w[i-15],18) ^ (w[i-15] >>> 3);
      const s1 = rotr(w[i-2],17) ^ rotr(w[i-2],19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Merge the request fingerprint into audit metadata. */
export function attachRequestFingerprintMetadata<T>(
  request: Request | undefined,
  metadata?: Record<string, T>,
): Record<string, T | string> {
  const base: Record<string, T | string> = { ...(metadata ?? {}) };
  if (request) base.requestFingerprint = generateFingerprint(request);
  return base;
}

export function generateFingerprint(request: Request): string {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    // Normalize path: trailing slashes removed
    let pathname = url.pathname;
    if (pathname.endsWith('/') && pathname.length > 1) {
      pathname = pathname.slice(0, -1);
    }
    pathname = pathname.toLowerCase();

    const clientIp = getClientIp(request.headers);
    const userAgent = request.headers.get('user-agent')?.trim().toLowerCase() || '';
    const acceptLanguage = request.headers.get('accept-language')?.split(',')[0].trim().toLowerCase() || '';
    const acceptEncoding = request.headers.get('accept-encoding')
      ?.split(',')
      .map((s) => s.trim().toLowerCase())
      .sort()
      .join(',') || '';

    const fingerprintString = [
      method,
      pathname,
      clientIp,
      userAgent,
      acceptLanguage,
      acceptEncoding,
    ].join('|');

    return sha256Hex(fingerprintString);
  } catch (error) {
    logger.warn('Failed to compute request fingerprint', { error });
    return 'fingerprint-error';
  }
}

export async function computeRequestFingerprintFromRequest(request: Request): Promise<string> {
  return generateFingerprint(request);
}

export function buildRequestFingerprintLogContext(
  request: Request,
  fingerprint: string
): Record<string, unknown> {
  return {
    type: 'request.fingerprint',
    method: request.method.toUpperCase(),
    pathname: extractRequestPathname(request),
    requestFingerprint: fingerprint,
  };
}

/**
 * Captures and returns the request fingerprint.
 *
 * @param request - The incoming request
 * @returns SHA-256 hash string
 */
export async function captureRequestFingerprint(request: Request): Promise<string> {
  const fp = generateFingerprint(request);
  if (activeAuditHook) {
    try {
      await activeAuditHook(request, fp);
    } catch (err) {
      logger.warn('Request fingerprint audit hook error', { error: err });
    }
  }
  return fp;
}
