/** @jest-environment node */

import { POST } from "./route";

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

function makePostRequest(body: ReadableStream<Uint8Array> | null): Request {
  return {
    url: "http://localhost/api/streams/template",
    method: "POST",
    headers: new Headers(),
    body,
  } as unknown as Request;
}

const validTemplate = {
  name: "Streaming Payroll",
  asset: "USDC",
  amountPerInterval: 10,
  intervalSeconds: 86400,
};

describe("POST /api/streams/template body limits", () => {
  it("accepts a chunked body with no Content-Length", async () => {
    const response = await POST(
      makePostRequest(
        streamFromChunks([
          '{"name":"Streaming Payroll",',
          '"asset":"USDC",',
          '"amountPerInterval":10,',
          '"intervalSeconds":86400}',
        ]),
      ),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      template: validTemplate,
    });
  });

  it("returns 413 for a body over the configured cap", async () => {
    const response = await POST(
      makePostRequest(streamFromChunks([new Uint8Array(300 * 1024)])),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "REQUEST_TOO_LARGE",
        request_id: expect.any(String),
      },
    });
  });

  it("returns 400 EMPTY_BODY for an empty body", async () => {
    const response = await POST(makePostRequest(streamFromChunks([])));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "EMPTY_BODY" },
    });
  });

  it("returns 400 INVALID_JSON for malformed JSON", async () => {
    const response = await POST(
      makePostRequest(streamFromChunks(['{"name":'])),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });

  it("returns 400 INVALID_JSON for invalid UTF-8", async () => {
    const response = await POST(
      makePostRequest(streamFromChunks([new Uint8Array([0x7b, 0xff, 0x7d])])),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON" },
    });
  });
});
