/**
 * X-Request-Id propagation utilities.
 *
 * Provides consistent request-id generation, validation, and header stamping
 * for all API requests flowing through the middleware pipeline.
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** Generates a unique request ID with req_ prefix. */
export function generateRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

/** Validates a request ID: max 128 chars, allowlist [A-Za-z0-9._:-] only. */
export function isValidRequestId(id: string): boolean {
  if (!id || id.length === 0 || id.length > 128) return false;
  return /^[A-Za-z0-9._:-]+$/.test(id);
}

/** Resolves a request ID from incoming headers or generates a fresh one. */
export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get(REQUEST_ID_HEADER);
  if (incoming && isValidRequestId(incoming)) {
    return incoming;
  }
  return generateRequestId();
}

/** Stamps the resolved request ID on forwarded request and response headers. */
export function applyRequestIdPolicy(
  incoming: Headers,
  forwarded: Headers,
  response: Headers,
): string {
  const resolved = resolveRequestId(incoming);
  forwarded.set(REQUEST_ID_HEADER, resolved);
  response.set(REQUEST_ID_HEADER, resolved);
  return resolved;
}
