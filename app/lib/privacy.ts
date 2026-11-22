import { Stream } from "@/app/types/openapi";
import { getStore } from "./db";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";

/**
 * Key fragments that identify credential or PII material. Matching is done on
 * a normalised key (lower-cased, `_`/`-` stripped) so `secret_key`,
 * `secretKey` and `SECRET-KEY` are all caught.
 *
 * Note: because matching is by substring, `tokenSymbol` and `tokenAddress`
 * also match `token` and are redacted. `redact` has no production callers
 * today, so no log field needs the asset code to stay readable; add an
 * allowlist here if one ever does.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "signature",
  "publickey",
  "secret",
  "password",
  "token",
  "email",
  "authorization",
  "apikey",
  "privatekey",
];

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalised = normaliseKey(key);
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/** Plain objects only — Date, Buffer, Map, class instances are left untouched. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy `data`, replacing sensitive values with `[REDACTED]`.
 *
 * - Arrays stay arrays; plain objects stay plain objects.
 * - `null` and primitives are returned as-is.
 * - Non-plain objects (Date, Buffer, …) are returned as-is.
 * - Cyclic references are replaced with `[CIRCULAR]`.
 * - The input is never mutated.
 */
export function redact(data: any): any {
  return redactValue(data, new WeakSet<object>());
}

function redactValue(data: any, seen: WeakSet<object>): any {
  if (typeof data !== "object" || data === null) return data;
  if (!Array.isArray(data) && !isPlainObject(data)) return data;
  if (seen.has(data)) return CIRCULAR;

  seen.add(data);
  try {
    if (Array.isArray(data)) {
      return data.map((item) => redactValue(item, seen));
    }

    const redacted: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      redacted[key] = isSensitiveKey(key)
        ? REDACTED
        : redactValue(data[key], seen);
    }
    return redacted;
  } finally {
    seen.delete(data);
  }
}

/**
 * Retention period: 7 years in milliseconds.
 */
const RETENTION_PERIOD_MS = 7 * 365 * 24 * 60 * 60 * 1000;

/**
 * Mask an email address for non-admin roles.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Scrub PII from a stream object based on the requester's role.
 * Role 'admin' sees everything; 'user' sees masked/redacted data.
 */
export function scrubStreamPII(stream: Stream, role: 'admin' | 'user' = 'user'): Stream {
  if (role === 'admin') return stream;

  return {
    ...stream,
    email: stream.email ? maskEmail(stream.email) : undefined,
    label: stream.label ? "[REDACTED]" : undefined,
    memo: stream.memo ? "[REDACTED]" : undefined,
    partnerId: stream.partnerId ? "[MASKED]" : undefined,
  };
}

/**
 * Check if a record is past its retention period.
 */
export function isPastRetention(createdAt: string): boolean {
  const createdDate = new Date(createdAt).getTime();
  const now = Date.now();
  return now - createdDate > RETENTION_PERIOD_MS;
}

/**
 * Process an account deletion request (DSR).
 * Permanently scrubs PII from streams and deletes the user record.
 * Legal/Audit requirement: Keep stream aggregates (IDs, amounts, status) for 7 years.
 */
export async function processDeletionRequest(walletAddress: string): Promise<{ requestId: string; status: string }> {
  const { streamRepository } = getStore();
  // 1. Scrub PII from all streams associated with this user
  // In a real DB, we'd query by user_id. Here we check recipient and email.
  const user = streamRepository.users.get(walletAddress);
  const userEmail = user?.email;
  const userName = user?.display_name;

  for (const [id, stream] of streamRepository.streams.entries()) {
    const isAssociated = 
      stream.email === userEmail || 
      (userName && stream.recipient.includes(userName)) ||
      stream.recipient.includes(walletAddress);

    if (isAssociated) {
      streamRepository.streams.set(id, {
        ...stream,
        email: undefined,
        label: undefined,
        memo: undefined,
        partnerId: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // 2. Delete user record
  streamRepository.users.delete(walletAddress);

  return {
    requestId: `dsr-${Math.random().toString(36).slice(2, 11)}`,
    status: "processing",
  };
}
