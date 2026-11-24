/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import StreamReceiptPage from "./page";
import { notFound } from "next/navigation";
import { _resetOrgDbForTesting, setOrgReceiptTheme } from "@/app/lib/org-db";

jest.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

jest.mock("next/navigation", () => ({
  notFound: jest.fn(),
}));

describe("StreamReceiptPage", () => {
  afterEach(_resetOrgDbForTesting);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the receipt builder for a known stream", async () => {
    const params = Promise.resolve({ id: "stream-ada" });
    const jsx = await StreamReceiptPage({ params });
    render(jsx);

    expect(
      screen.getByRole("article", { name: /payment stream receipt/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("stream-ada")).toBeInTheDocument();
    expect(screen.getByText("Ada Creative Studio")).toBeInTheDocument();
  });

  it("applies the current organization theme to a receipt request", async () => {
    setOrgReceiptTheme("org-acme", { accentColor: "#456", message: "Thanks, Ada!" });
    const params = Promise.resolve({ id: "stream-ada" });
    const { rerender } = render(await StreamReceiptPage({ params }));
    expect(screen.getByText("Thanks, Ada!")).toBeInTheDocument();

    setOrgReceiptTheme("org-acme", undefined);
    rerender(await StreamReceiptPage({ params }));
    expect(screen.queryByText("Thanks, Ada!")).not.toBeInTheDocument();
  });

  it("renders the note textarea", async () => {
    const params = Promise.resolve({ id: "stream-ada" });
    const jsx = await StreamReceiptPage({ params });
    render(jsx);

    expect(
      screen.getByRole("textbox", { name: /custom note/i }),
    ).toBeInTheDocument();
  });

  it("renders print and share buttons", async () => {
    const params = Promise.resolve({ id: "stream-kemi" });
    const jsx = await StreamReceiptPage({ params });
    render(jsx);

    expect(
      screen.getByRole("button", { name: /print \/ save as pdf/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^share$/i }),
    ).toBeInTheDocument();
  });

  it("calls notFound for unknown stream id", async () => {
    const params = Promise.resolve({ id: "non-existent" });
    await StreamReceiptPage({ params });
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
