import { renderToStaticMarkup } from "react-dom/server";
import type { Stream } from "@/app/types/openapi";
import { getStore } from "@/app/lib/db";
import { verifyEmbedToken } from "@/lib/embed-token";
import EmbedStreamPage from "./page";

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

jest.mock("@/app/lib/db", () => ({
  getStore: jest.fn(),
}));

jest.mock("@/lib/embed-token", () => ({
  verifyEmbedToken: jest.fn(),
}));

describe("EmbedStreamPage", () => {
  const privateRecipient = "GPRIVATE123456789012345678901234567890";
  const privateEmail = "customer-private@example.com";
  const privateMemo = "Confidential payment memo";
  const privateLabel = "Private customer label";
  const privatePartnerId = "partner-private-123";

  const stream = {
    id: "stream-123",
    recipient: privateRecipient,
    senderAddress: "GSENDER123456789012345678901234567890",
    rate: "10 USDC",
    schedule: "Weekly",
    status: "ACTIVE",
    token: "USDC",
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
    email: privateEmail,
    memo: privateMemo,
    label: privateLabel,
    partnerId: privatePartnerId,
  } as unknown as Stream;

  beforeEach(() => {
    jest.clearAllMocks();

    (getStore as jest.Mock).mockReturnValue({
      streamRepository: {
        streams: {
          get: jest.fn().mockResolvedValue(stream),
        },
      },
    });

    (verifyEmbedToken as jest.Mock).mockReturnValue(true);
  });

  it("renders the public stream information", async () => {
    const page = await EmbedStreamPage({
      params: Promise.resolve({ id: "stream-123" }),
      searchParams: Promise.resolve({ t: "valid-token" }),
    });

    const html = renderToStaticMarkup(page);

    expect(html).toContain("StreamPay");
    expect(html).toContain("Payment progress");
    expect(html).toContain("Recipient");
    expect(html).toContain("10 USDC");
    expect(html).toContain("Weekly");
    expect(html).toContain("50%");
  });

  it("does not expose private stream information in rendered HTML", async () => {
    const page = await EmbedStreamPage({
      params: Promise.resolve({ id: "stream-123" }),
      searchParams: Promise.resolve({ t: "valid-token" }),
    });

    const html = renderToStaticMarkup(page);

    expect(html).not.toContain(privateRecipient);
    expect(html).not.toContain(privateEmail);
    expect(html).not.toContain(privateMemo);
    expect(html).not.toContain(privateLabel);
    expect(html).not.toContain(privatePartnerId);
  });

  it("rejects an invalid embed token", async () => {
    (verifyEmbedToken as jest.Mock).mockReturnValue(false);

    await expect(
      EmbedStreamPage({
        params: Promise.resolve({ id: "stream-123" }),
        searchParams: Promise.resolve({ t: "invalid-token" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("rejects a missing stream", async () => {
    (getStore as jest.Mock).mockReturnValue({
      streamRepository: {
        streams: {
          get: jest.fn().mockResolvedValue(undefined),
        },
      },
    });

    await expect(
      EmbedStreamPage({
        params: Promise.resolve({ id: "unknown-stream" }),
        searchParams: Promise.resolve({ t: "valid-token" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
