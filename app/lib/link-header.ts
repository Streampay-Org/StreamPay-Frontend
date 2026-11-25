/**
 * RFC 8288 Web Linking (`Link` HTTP header) serialization helpers for
 * cursor-paginated list endpoints.
 */

export type QueryParamValue = string | number | boolean | null | undefined;
export type QueryParamsInput = URLSearchParams | Record<string, QueryParamValue>;

export interface BuildLinkHeaderOptions {
  /** Base path or URL (e.g. `/api/v2/streams` or `/api/activity`). */
  baseUrl: string;
  /** Current query parameters to preserve across generated links. */
  params?: QueryParamsInput;
  /** Cursor for `rel="next"`. Omitted when null/undefined/empty. */
  next?: string | null;
  /** Cursor for `rel="prev"`. Omitted when null/undefined/empty. */
  prev?: string | null;
  /**
   * Controls `rel="self"`:
   * - `true`: emit `rel="self"` using `baseUrl` and `params` as-is.
   * - `string`: if it starts with `/` or `http(s)://`, use it directly as the
   *   target URI; otherwise treat it as a cursor value.
   * - `false | null | undefined`: omit `rel="self"`.
   */
  self?: string | boolean | null;
}

function toSearchParams(params?: QueryParamsInput): URLSearchParams {
  const result = new URLSearchParams();
  if (!params) {
    return result;
  }
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => {
      result.append(key, value);
    });
    return result;
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      result.set(key, String(value));
    }
  }
  return result;
}

/**
 * Build a URL by attaching serialized query parameters to `baseUrl`.
 * Existing query parameters on `baseUrl` are preserved unless overwritten.
 */
export function buildUrlWithParams(
  baseUrl: string,
  params?: QueryParamsInput,
): string {
  const qs = toSearchParams(params).toString();
  if (!qs) {
    return baseUrl;
  }
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${qs}`;
}

function buildCursorUrl(
  baseUrl: string,
  params: QueryParamsInput | undefined,
  cursor: string,
): string {
  const nextParams = toSearchParams(params);
  nextParams.set("cursor", cursor);
  return buildUrlWithParams(baseUrl, nextParams);
}

function formatLinkEntry(uri: string, rel: string): string {
  return `<${uri}>; rel="${rel}"`;
}

/**
 * Serialize pagination links as an RFC 8288 `Link` header value.
 *
 * Returns `null` when no link relations are emitted.
 */
export function buildLinkHeader({
  baseUrl,
  params,
  next,
  prev,
  self,
}: BuildLinkHeaderOptions): string | null {
  const entries: string[] = [];

  if (typeof next === "string" && next.length > 0) {
    entries.push(formatLinkEntry(buildCursorUrl(baseUrl, params, next), "next"));
  }

  if (typeof prev === "string" && prev.length > 0) {
    entries.push(formatLinkEntry(buildCursorUrl(baseUrl, params, prev), "prev"));
  }

  if (self === true) {
    entries.push(formatLinkEntry(buildUrlWithParams(baseUrl, params), "self"));
  } else if (typeof self === "string" && self.length > 0) {
    const isAbsoluteOrPath =
      self.startsWith("/") || self.startsWith("http://") || self.startsWith("https://");
    const selfUrl = isAbsoluteOrPath ? self : buildCursorUrl(baseUrl, params, self);
    entries.push(formatLinkEntry(selfUrl, "self"));
  }

  return entries.length > 0 ? entries.join(", ") : null;
}
