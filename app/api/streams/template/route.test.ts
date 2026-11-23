/** @jest-environment node */

import { GET, POST } from "./route";

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

function makeJsonPostRequest(data: unknown): Request {
  return makePostRequest(streamFromChunks([JSON.stringify(data)]));
}

const validTemplate = {
  name: "Streaming Payroll",
  asset: "USDC",
  amountPerInterval: "10",
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

describe("GET /api/streams/template", () => {
  it("returns seeded templates with amountPerInterval as decimal strings", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(Array.isArray(data.templates)).toBe(true);
    expect(data.templates.length).toBeGreaterThanOrEqual(6);

    for (const tpl of data.templates) {
      expect(typeof tpl.id).toBe("string");
      expect(typeof tpl.name).toBe("string");
      expect(typeof tpl.asset).toBe("string");
      expect(typeof tpl.amountPerInterval).toBe("string");
      expect(typeof tpl.intervalSeconds).toBe("number");
    }
  });
});

describe("POST /api/streams/template validation and features", () => {
  it("Scenario 1: stores and returns decimal string amount '120.5'", async () => {
    const response = await POST(
      makeJsonPostRequest({
        name: "Design Retainer",
        asset: "XLM",
        amountPerInterval: "120.5",
        intervalSeconds: 2592000,
      }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.template.amountPerInterval).toBe("120.5");
    expect(data.template.id).toMatch(/^tpl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("Scenario 2: rejects more than 7 decimal places ('0.12345678') with 422 INVALID_AMOUNT", async () => {
    const response = await POST(
      makeJsonPostRequest({
        name: "Micro",
        asset: "USDC",
        amountPerInterval: "0.12345678",
        intervalSeconds: 604800,
      }),
    );

    expect(response.status).toBe(422);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_AMOUNT");
    expect(data.error.request_id).toBeDefined();
  });

  it("Scenario 3: rejects non-numeric or malformed values ('abc', 'Infinity', '1e-9') with 422", async () => {
    for (const badAmount of ["abc", "Infinity", "1e-9", "0", "-5"]) {
      const response = await POST(
        makeJsonPostRequest({
          name: "Test",
          asset: "USDC",
          amountPerInterval: badAmount,
          intervalSeconds: 86400,
        }),
      );

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error.code).toBe("INVALID_AMOUNT");
    }
  });

  it("Scenario 4: rejects intervalSeconds < 60, > 31536000, or non-integer with 422 INVALID_INTERVAL", async () => {
    for (const badInterval of [59.5, 10, 0, -100, 31536001, "abc"]) {
      const response = await POST(
        makeJsonPostRequest({
          name: "Test Interval",
          asset: "USDC",
          amountPerInterval: "50",
          intervalSeconds: badInterval,
        }),
      );

      expect(response.status).toBe(422);
      const data = await response.json();
      expect(data.error.code).toBe("INVALID_INTERVAL");
    }
  });

  it("Scenario 5: 100 parallel POSTs mint 100 distinct collision-free IDs even when Date.now is frozen", async () => {
    const originalDateNow = Date.now;
    const frozenTime = 1700000000000;
    jest.spyOn(Date, "now").mockReturnValue(frozenTime);

    try {
      const requests = Array.from({ length: 100 }, (_, i) =>
        POST(
          makeJsonPostRequest({
            name: `Parallel Template ${i}`,
            asset: "USDC",
            amountPerInterval: "100",
            intervalSeconds: 86400,
          }),
        ),
      );

      const responses = await Promise.all(requests);
      const ids = new Set<string>();

      for (const res of responses) {
        expect(res.status).toBe(201);
        const data = await res.json();
        expect(data.template.id).toMatch(/^tpl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        ids.add(data.template.id);
      }

      expect(ids.size).toBe(100);
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("Scenario 6: accepts legacy numeric input 120 and stores as decimal string '120'", async () => {
    const response = await POST(
      makeJsonPostRequest({
        name: "Legacy Numeric",
        asset: "USDC",
        amountPerInterval: 120,
        intervalSeconds: 86400,
      }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.template.amountPerInterval).toBe("120");
  });

  it("Scenario 6: rejects numeric input where precision would be lost with 422", async () => {
    // 0.1 + 0.2 produces 0.30000000000000004
    const resLost = await POST(
      makeJsonPostRequest({
        name: "Precision Lost",
        asset: "USDC",
        amountPerInterval: 0.1 + 0.2,
        intervalSeconds: 86400,
      }),
    );

    expect(resLost.status).toBe(422);
    const dataLost = await resLost.json();
    expect(dataLost.error.code).toBe("INVALID_AMOUNT");

    // Scientific notation
    const resExp = await POST(
      makeJsonPostRequest({
        name: "Exp",
        asset: "USDC",
        amountPerInterval: 1e-9,
        intervalSeconds: 86400,
      }),
    );

    expect(resExp.status).toBe(422);
    const dataExp = await resExp.json();
    expect(dataExp.error.code).toBe("INVALID_AMOUNT");
  });

  it("enforces validation precedence: name -> asset -> amount -> interval", async () => {
    // Missing name takes precedence over all else
    const res1 = await POST(
      makeJsonPostRequest({
        name: "   ",
        asset: "",
        amountPerInterval: "invalid",
        intervalSeconds: -1,
      }),
    );
    expect(res1.status).toBe(422);
    expect((await res1.json()).error.code).toBe("MISSING_NAME");

    // Valid name, missing asset takes precedence over amount
    const res2 = await POST(
      makeJsonPostRequest({
        name: "Valid Name",
        asset: "",
        amountPerInterval: "invalid",
        intervalSeconds: -1,
      }),
    );
    expect(res2.status).toBe(422);
    expect((await res2.json()).error.code).toBe("MISSING_ASSET");

    // Valid name & asset, invalid amount takes precedence over interval
    const res3 = await POST(
      makeJsonPostRequest({
        name: "Valid Name",
        asset: "USDC",
        amountPerInterval: "invalid",
        intervalSeconds: -1,
      }),
    );
    expect(res3.status).toBe(422);
    expect((await res3.json()).error.code).toBe("INVALID_AMOUNT");

    // Valid name, asset & amount, invalid interval
    const res4 = await POST(
      makeJsonPostRequest({
        name: "Valid Name",
        asset: "USDC",
        amountPerInterval: "100",
        intervalSeconds: -1,
      }),
    );
    expect(res4.status).toBe(422);
    expect((await res4.json()).error.code).toBe("INVALID_INTERVAL");
  });
});

