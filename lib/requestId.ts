/**
 * X-Request-Id propagation utilities.
 *
 * Provides consistent request-id generation, validation, and header stamping
 * for all API requests flowing through the middleware pipeline.
 */

export const REQUEST_ID_HEADER = "x-request-id";

/** Generates a unique request ID with req_ prefix. */
export function generateRequestId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : fallbackUuidV4();
  return `req_${uuid}`;
}

/** RFC 4122 v4 UUID fallback for environments without crypto.randomUUID. */
function fallbackUuidV4(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
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
