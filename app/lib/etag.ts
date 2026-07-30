import { createHash } from "crypto";

/**
 * Deterministic JSON serializer used to feed the ETag hash.
 *
 * - Object keys are emitted in sorted order so that semantically-equal values
 *   always hash to the same digest regardless of property order.
 * - Arrays preserve their order.
 * - Primitives are encoded with {@link JSON.stringify}.
 *
 * Cycles are not expected for stream resources; if one ever appears we
 * surface it loudly so we can opt into a non-cyclic representation rather
 * than silently poisoning the ETag space.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    // Explicit `null` and absent (`undefined`) keys hash identically so that
    // semantically-equivalent streams produce the same digest regardless of
    // which absence marker the producer used. `JSON.stringify(undefined)`
    // returns the JS value `undefined`, which would make hash output
    // non-deterministic when interpolated into the canonical string.
    return "null";
  }

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Plain object only — Date/Map/Set are not expected for stream payloads
    // and are intentional fallthroughs to JSON.stringify for safety.
    const ctor = (obj as { constructor?: { name?: string } }).constructor;
    if (ctor && ctor.name && ctor.name !== "Object") {
      return JSON.stringify(value);
    }
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ":" + canonicalize(obj[k]));
    }
    return "{" + parts.join(",") + "}";
  }

  // Fallback for symbols, functions, undefined — these shouldn't appear in a
  // serialized stream resource. Returning `null` keeps the hash stable.
  return "null";
}

/**
 * Compute a **strong** entity-tag for the given stream representation.
 *
 * The hash input is deliberately prefixed with the tenant id so that two
 * tenants holding a record with the same `id` cannot collide on the same
 * ETag — this prevents cross-tenant cache poisoning via shared proxies. The
 * resulting ETag is double-quoted as required by RFC 7232 §2.3.
 */
export function computeETag(tenant: string, stream: unknown): string {
  if (!tenant || tenant.trim() === "") {
    throw new Error("computeETag: tenant is required");
  }
  const payload = `tenant=${tenant}\n${canonicalize(stream)}`;
  const hex = createHash("sha256").update(payload).digest("hex");
  return `"${hex}"`;
}

/**
 * Decide whether the `If-None-Match` request header matches the supplied
 * entity-tag, per RFC 7232 §3.2:
 *
 * - `"*"` matches if the resource exists (i.e. any non-empty current tag).
 * - Otherwise the header is a comma-separated list of entity-tags.
 * - Strong and weak tags can be compared opaquely — the `W/` prefix is
 *   stripped for comparison because RFC 7232 says weak comparison is used
 *   for `If-None-Match`.
 * - Malformed entries (unbalanced quotes, garbage) are ignored so an
 *   attacker-controlled header cannot trigger a spurious 304.
 */
export function ifNoneMatchMatches(
  headerValue: string | null,
  currentETag: string
): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return Boolean(currentETag);

  const current = stripWeakPrefix(currentETag.trim());
  // Entity-tags themselves don't contain commas in our usage, so a simple
  // split is safe and forgiving. Malformed candidates are tolerated — we
  // simply won't match against them.
  const candidates = trimmed.split(",").map((c) => stripWeakPrefix(c.trim()));
  return candidates.some(
    (c) => c.length > 0 && c === current
  );
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}
