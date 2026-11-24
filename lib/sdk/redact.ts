/**
 * lib/sdk/redact.ts — Deterministic redaction for client-side diagnostics
 *
 * The partner SDK surfaces failure details to callers (and, transitively, to
 * their logs/telemetry) via `StreamPaySdkError.details`. Servers commonly echo
 * the submitted request payload back inside validation error responses, so an
 * unredacted `details` payload can leak sensitive request-body fields (tokens,
 * secrets, signatures, seeds, …) into client-side diagnostics.
 *
 * This module provides a single, pure, total redaction function for JSON
 * bodies that are about to enter diagnostics. It never throws, never mutates
 * its input, and always returns a deterministic result.
 *
 * Invariants
 * ──────────
 *  1. **Pure & total** — never throws, never mutates its argument, works for
 *     valid, invalid, duplicate, and boundary-case inputs.
 *  2. **Deterministic** — identical input always yields identical output.
 *  3. **Least privilege** — only sensitive fields are masked; non-sensitive
 *     fields survive so failures remain diagnosable.
 *  4. **Abuse resistant** — key matching is bounded (no unbounded expansion),
 *     deeply nested / cyclic structures are handled without recursion blowup,
 *     and oversized strings are truncated to prevent log flooding.
 *  5. **Fail closed** — if a value cannot be processed it is redacted rather
 *     than passed through.
 *
 * Public keys / wallet addresses are intentionally NOT redacted: they are
 * public on-chain identifiers and redacting them would destroy diagnosability
 * without a privacy benefit (mirrors the `NOT_SECRET` handling in
 * `app/lib/config`).
 */

/** Sentinel value used for any redacted field. */
export const REDACTED = "[REDACTED]";

/** Suffix appended to strings truncated to `MAX_STRING_LENGTH`. */
export const TRUNCATED_SUFFIX = "…[truncated]";

/** Maximum string length kept in diagnostics (prevents log flooding). */
export const MAX_STRING_LENGTH = 2048;

/** Maximum object/array nesting depth to walk (prevents recursion blowup). */
export const MAX_DEPTH = 20;

/**
 * Key tokens that identify credential material. Matched case-insensitively as
 * substrings so both camelCase (`privateKey`) and snake_case (`private_key`)
 * keys are caught, matching the behavior of the repo's existing
 * `sanitizeMetadata` / `redactSecrets` helpers.
 *
 * `key` is deliberately NOT a bare token — it over-matches ordinary words such
 * as `monkey` / `keyboard`; composite `api_key` / `access_key` shapes are
 * matched explicitly instead.
 */
const SENSITIVE_KEY_TOKENS = [
  "secret",
  "password",
  "passphrase",
  "token",
  "private",
  "signing",
  "signature",
  "seed",
  "mnemonic",
  "credential",
  "authorization",
  "bearer",
  "jwt",
  "hmac",
  "recovery",
];

/** Composite API/access key shapes (`apikey`, `api_key`, `api-key`, …). */
const COMPOSITE_KEY_PATTERNS = [
  /(^|[^a-z0-9])api[_-]?key([^a-z0-9]|$)/,
  /(^|[^a-z0-9])access[_-]?key([^a-z0-9]|$)/,
];

/**
 * A Stellar secret seed (`S` followed by 55 base32 characters). High signal,
 * effectively zero false positives, so it is caught even under a non-sensitive
 * key (e.g. a list of secrets or a payload that nests them under arbitrary
 * names).
 */
const STELLAR_SECRET_KEY_PATTERN = /^S[2-7A-Z]{55}$/;

/** PEM private key blocks (`-----BEGIN … PRIVATE KEY-----…`). */
const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Returns true when `key` identifies credential material that must never
 * reach client-side diagnostics.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEY_TOKENS.some((token) => lower.includes(token))) {
    return true;
  }
  return COMPOSITE_KEY_PATTERNS.some((pattern) => pattern.test(lower));
}

/**
 * Returns true when `value` is secret material in its own right, regardless
 * of the key it sits under.
 */
export function isSensitiveValue(value: string): boolean {
  return (
    STELLAR_SECRET_KEY_PATTERN.test(value) ||
    PEM_PRIVATE_KEY_PATTERN.test(value)
  );
}

/**
 * Redacts sensitive fields from a JSON body before it enters client-side
 * diagnostics.
 *
 * @param value - Arbitrary JSON-serializable value (also tolerates `null`,
 *                primitives, and cyclic references).
 * @param depth - Internal recursion depth; not intended for callers.
 * @param active - Internal set of objects currently being visited (cycle guard).
 * @returns A deep, redacted copy of `value`. Never throws, never mutates input.
 */
export function redactDiagnosticBody(
  value: unknown,
  depth = 0,
  active: Set<object> = new Set(),
): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      if (isSensitiveValue(value)) {
        return REDACTED;
      }
      return value.length > MAX_STRING_LENGTH
        ? value.slice(0, MAX_STRING_LENGTH) + TRUNCATED_SUFFIX
        : value;
    }
    return value;
  }

  // Preserve structure below the cap without descending any further.
  if (depth >= MAX_DEPTH) {
    return value;
  }

  // Cycle guard: repeated references to the same object in a cycle are
  // replaced rather than recursed, so pathological payloads terminate.
  if (active.has(value)) {
    return REDACTED;
  }
  active.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactDiagnosticBody(item, depth + 1, active));
    }

    // Null-prototype output avoids prototype-pollution via keys like
    // "__proto__" / "constructor".
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key)
        ? REDACTED
        : redactDiagnosticBody(val, depth + 1, active);
    }
    return out;
  } catch {
    // Fail closed: unprocessable values must not pass through to diagnostics.
    return REDACTED;
  } finally {
    active.delete(value);
  }
}
