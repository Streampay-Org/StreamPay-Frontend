export function redact(data: any): any {
  if (typeof data !== 'object' || data === null) return data;
  const redacted = { ...data };
  const keysToRedact = ['signature', 'publickey', 'secret', 'password', 'token', 'email'];
  for (const key in redacted) {
    if (keysToRedact.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'object') {
      redacted[key] = redact(redacted[key]);
    }
  }
  return redacted;
}
import crypto from "crypto";
import { Stream } from "@/app/types/openapi";
import { getStore } from "./db";

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
export async function processDeletionRequest(
  walletAddress: string
): Promise<{ requestId: string; status: string; scrubbedCount: number }> {
  const { streamRepository } = getStore();
  // 1. Scrub PII from all streams associated with this user
  const user = streamRepository.users.get(walletAddress);
  const normalizedUserEmail =
    typeof user?.email === "string" && user.email.trim().length > 0
      ? user.email.trim().toLowerCase()
      : null;

  let scrubbedCount = 0;

  for (const [id, stream] of streamRepository.streams.entries()) {
    const streamWithAliases = stream as Stream & {
      sender?: string;
      recipientAddress?: string;
    };

    const matchesWallet =
      Boolean(walletAddress) &&
      (stream.senderAddress === walletAddress ||
        streamWithAliases.sender === walletAddress ||
        streamWithAliases.recipientAddress === walletAddress ||
        stream.recipient === walletAddress);

    const normalizedStreamEmail =
      typeof stream.email === "string" && stream.email.trim().length > 0
        ? stream.email.trim().toLowerCase()
        : null;

    const matchesEmail =
      normalizedUserEmail !== null && normalizedStreamEmail === normalizedUserEmail;

    if (matchesWallet || matchesEmail) {
      streamRepository.streams.set(id, {
        ...stream,
        email: undefined,
        label: undefined,
        memo: undefined,
        partnerId: undefined,
        updatedAt: new Date().toISOString(),
      });
      scrubbedCount += 1;
    }
  }

  // 2. Delete user record
  streamRepository.users.delete(walletAddress);

  return {
    requestId: `dsr-${crypto.randomUUID()}`,
    status: "processing",
    scrubbedCount,
  };
}
