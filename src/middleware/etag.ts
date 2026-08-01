import { createHash } from "crypto";
import { NextResponse } from "next/server";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
}

export function createStrongEtag(value: unknown): string {
  const canonical = JSON.stringify(sortKeys(value));
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `"${hash}"`;
}

/**
 * Strong ETag over the exact response body bytes (no JSON canonicalisation).
 * Use for non-JSON representations such as Prometheus text exposition.
 */
export function createStrongEtagFromBody(body: string): string {
  const hash = createHash("sha256").update(body).digest("hex");
  return `"${hash}"`;
}

function normaliseEtagToken(token: string): string {
  return token.trim().replace(/^W\//i, "");
}

export function isIfNoneMatchMatch(etag: string, ifNoneMatchHeader: string | null): boolean {
  if (!ifNoneMatchHeader) {
    return false;
  }

  const normalisedEtag = normaliseEtagToken(etag);
  return ifNoneMatchHeader
    .split(",")
    .map((token) => token.trim())
    .some((token) => {
      if (token === "*") {
        return true;
      }

      return normaliseEtagToken(token) === normalisedEtag;
    });
}

export function createCacheHeaders(etag: string): Record<string, string> {
  return {
    etag,
    "cache-control": "public, max-age=0, must-revalidate",
  };
}

/**
 * Convenience wrapper that computes a strong ETag for `data`, checks the
 * incoming `If-None-Match` header, and returns either:
 *  - `304 Not Modified` (empty body, ETag + Cache-Control headers) when the
 *    client already holds a matching representation, or
 *  - `200 OK` with the JSON-serialised `data` and ETag + Cache-Control headers.
 */
export function withStrongEtag(request: Request, data: unknown): NextResponse {
  const etag = createStrongEtag(data);
  const cacheHeaders = createCacheHeaders(etag);
  const ifNoneMatch = request.headers?.get("if-none-match") ?? null;

  if (isIfNoneMatchMatch(etag, ifNoneMatch)) {
    return new NextResponse(null, {
      status: 304,
      headers: cacheHeaders,
    });
  }

  return NextResponse.json(data, {
    status: 200,
    headers: cacheHeaders,
  });
}

/**
 * Strong ETag / 304 helper for raw (non-JSON) response bodies.
 *
 * Hashes the exact body bytes so the validator remains strong for text
 * representations such as Prometheus metrics from `GET /api/webhooks`.
 */
export function withStrongEtagBody(
  request: Request,
  body: string,
  contentType: string,
): NextResponse {
  const etag = createStrongEtagFromBody(body);
  const cacheHeaders = createCacheHeaders(etag);
  const ifNoneMatch = request.headers?.get("if-none-match") ?? null;

  if (isIfNoneMatchMatch(etag, ifNoneMatch)) {
    return new NextResponse(null, {
      status: 304,
      headers: cacheHeaders,
    });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      ...cacheHeaders,
    },
  });
}
