/** @jest-environment node */

import {
  BodyTooLargeError,
  InvalidJsonError,
  readJsonBody,
} from "./readJsonBody";

const encoder = new TextEncoder();

function streamFromChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

function requestWithBody(
  body: ReadableStream<Uint8Array> | null,
): Pick<Request, "body"> {
  return { body } as Pick<Request, "body">;
}

describe("readJsonBody", () => {
  it("parses JSON from a chunked body with no Content-Length", async () => {
    const body = streamFromChunks(['{"event":', '"payment.received",', '"ok":true}']);

    await expect(readJsonBody(requestWithBody(body), { maxBytes: 1024 })).resolves.toEqual({
      event: "payment.received",
      ok: true,
    });
  });

  it("accepts a body exactly at the byte limit", async () => {
    const payload = '{"a":1}';
    const body = streamFromChunks([payload]);

    await expect(
      readJsonBody(requestWithBody(body), { maxBytes: encoder.encode(payload).byteLength }),
    ).resolves.toEqual({ a: 1 });
  });

  it("rejects as soon as the streamed body exceeds the limit", async () => {
    const body = streamFromChunks(["1234", "5678"]);

    await expect(readJsonBody(requestWithBody(body), { maxBytes: 5 })).rejects.toMatchObject({
      name: "BodyTooLargeError",
      maxBytes: 5,
      receivedBytes: 8,
    });
  });

  it("cancels the underlying reader when the limit is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("too-large"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      readJsonBody(requestWithBody(body), { maxBytes: 3 }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("rejects an empty stream with EMPTY_BODY", async () => {
    const body = streamFromChunks([]);

    await expect(readJsonBody(requestWithBody(body), { maxBytes: 16 })).rejects.toMatchObject({
      name: "InvalidJsonError",
      code: "EMPTY_BODY",
    });
  });

  it("rejects a missing request body with EMPTY_BODY", async () => {
    await expect(readJsonBody(requestWithBody(null), { maxBytes: 16 })).rejects.toMatchObject({
      name: "InvalidJsonError",
      code: "EMPTY_BODY",
    });
  });

  it("rejects malformed JSON with INVALID_JSON", async () => {
    const body = streamFromChunks(['{"unterminated":']);

    const error = await readJsonBody(requestWithBody(body), { maxBytes: 64 }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(InvalidJsonError);
    expect(error).toMatchObject({ code: "INVALID_JSON" });
  });

  it("rejects invalid UTF-8 instead of replacing bytes", async () => {
    const body = streamFromChunks([new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])]);

    const error = await readJsonBody(requestWithBody(body), { maxBytes: 64 }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(InvalidJsonError);
    expect(error).toMatchObject({
      code: "INVALID_JSON",
      message: "Request body must be valid UTF-8.",
    });
  });
});
