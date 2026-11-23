/**
 * Streaming JSON body reader with a hard byte cap.
 *
 * The middleware performs an O(1) check against `Content-Length`, but requests
 * using chunked transfer encoding (or omitting the header entirely) bypass
 * that check. `readJsonBody` is the second enforcement layer: it streams the
 * Web Streams body, counts raw bytes, and aborts as soon as `maxBytes` is
 * exceeded so oversized payloads are never fully buffered.
 *
 * Web Streams only; compatible with both the Node.js and Edge runtimes.
 */

export type InvalidJsonErrorCode = "INVALID_JSON" | "EMPTY_BODY";

/** Thrown as soon as a request body grows beyond the configured byte cap. */
export class BodyTooLargeError extends Error {
  readonly code = "BODY_TOO_LARGE" as const;
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(maxBytes: number, receivedBytes: number) {
    super(`Request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "BodyTooLargeError";
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
    Object.setPrototypeOf(this, BodyTooLargeError.prototype);
  }
}

/** Thrown when the body is empty, not valid UTF-8, or not valid JSON. */
export class InvalidJsonError extends Error {
  readonly code: InvalidJsonErrorCode;

  constructor(
    code: InvalidJsonErrorCode = "INVALID_JSON",
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(
      message ??
        (code === "EMPTY_BODY"
          ? "Request body is empty."
          : "Request body must be valid JSON."),
    );
    this.name = "InvalidJsonError";
    this.code = code;
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, InvalidJsonError.prototype);
  }
}

export interface ReadJsonBodyOptions {
  /** Hard upper bound on the raw request body size, in bytes. */
  maxBytes: number;
}

/**
 * Reads and parses a JSON request body without exceeding `maxBytes`.
 *
 * - Counts bytes as they arrive; rejects with `BodyTooLargeError` on the first
 *   chunk that crosses the limit and cancels the underlying reader.
 * - Decodes as UTF-8 with `fatal: true`, so invalid byte sequences are
 *   rejected rather than silently replaced.
 * - Returns `InvalidJsonError` with code `EMPTY_BODY` when there are no bytes.
 *
 * Memory usage is bounded by `maxBytes`: the chunk that crosses the limit is
 * discarded rather than appended to the buffer.
 */
export async function readJsonBody<T = unknown>(
  request: Pick<Request, "body">,
  options: ReadJsonBodyOptions,
): Promise<T> {
  const { maxBytes } = options;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      `maxBytes must be a non-negative finite number; received ${String(maxBytes)}.`,
    );
  }
  const limit = Math.floor(maxBytes);

  const body = request.body;
  if (!body) {
    throw new InvalidJsonError("EMPTY_BODY");
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored/closed; the cap still applies.
        }
        throw new BodyTooLargeError(limit, receivedBytes);
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw error;
    }
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body could not be read.",
      { cause: error },
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures on already-closed or cancelled streams.
    }
  }

  if (receivedBytes === 0) {
    throw new InvalidJsonError("EMPTY_BODY");
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body must be valid UTF-8.",
      { cause },
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new InvalidJsonError(
      "INVALID_JSON",
      "Request body must be valid JSON.",
      { cause },
    );
  }
}
