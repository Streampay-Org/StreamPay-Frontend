/** @jest-environment node */
import { GET } from "./route";
import { resetDb } from "@/app/lib/db";
import { signToken } from "@/app/lib/auth";
import type { Stream } from "@/app/types/openapi";

const stream: Stream = {
  id: "stream-pdf",
  tenant: "tenant-a",
  recipient: "GRECIPIENTADDRESS123456789",
  senderAddress: "GSENDERADDRESS123456789",
  rate: "25",
  schedule: "monthly",
  status: "active",
  token: "XLM",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  email: "private@example.com",
  label: "Private label",
  memo: "Private memo",
};

function request(
  url = "http://localhost/api/streams/stream-pdf/receipt/pdf",
  wallet = stream.senderAddress!,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    headers: {
      Authorization: `Bearer ${signToken(wallet)}`,
      "x-tenant-id": "tenant-a",
      ...headers,
    },
  });
}

describe("GET /api/streams/:id/receipt/pdf", () => {
  beforeEach(() => {
    resetDb({ [stream.id]: stream });
  });

  it("requires authentication and hides unknown or invisible streams", async () => {
    const unauthenticated = await GET(
      new Request("http://localhost/api/streams/stream-pdf/receipt/pdf"),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(unauthenticated.status).toBe(401);

    const invisible = await GET(
      request(undefined, "GUNRELATED"),
      { params: Promise.resolve({ id: stream.id }) },
    );
    expect(invisible.status).toBe(404);

    const unknown = await GET(
      request(),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(unknown.status).toBe(404);
  });

  it("renders a themed anonymous PDF without PII and supports ETag revalidation", async () => {
    const url =
      "http://localhost/api/streams/stream-pdf/receipt/pdf?anonymous=true&accentColor=%23ff0000&message=Thank%20you";
    const first = await GET(request(url), { params: Promise.resolve({ id: stream.id }) });
    const pdf = new TextDecoder().decode(await first.arrayBuffer());
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/pdf");
    expect(first.headers.get("content-disposition")).toContain("streampay-receipt-stream-pdf.pdf");
    expect(first.headers.get("cache-control")).toContain("private");
    expect(pdf).toContain("Thank you");
    expect(pdf).not.toContain(stream.recipient);
    expect(pdf).not.toContain(stream.senderAddress);
    expect(pdf).not.toContain(stream.email);
    expect(pdf).not.toContain(stream.label);
    expect(pdf).not.toContain(stream.memo);

    const revalidated = await GET(request(url, stream.senderAddress!, { "If-None-Match": etag! }), {
      params: Promise.resolve({ id: stream.id }),
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  it("falls back safely for invalid theme values", async () => {
    const response = await GET(
      request(
        "http://localhost/api/streams/stream-pdf/receipt/pdf?accentColor=not-a-color&message=%20%20",
      ),
      { params: Promise.resolve({ id: stream.id }) },
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain("Amount: 25 XLM");
  });
});
