import { createHash } from 'node:crypto';
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

    return createHash('sha256').update(fingerprintString).digest('hex');
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
