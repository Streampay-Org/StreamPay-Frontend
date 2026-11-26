import type { Stream } from "@/app/types/openapi";
import { toAnonymousReceipt } from "./anon-receipt";
import { renderReceiptPdf } from "./receipt-pdf";
import { normalizeReceiptTheme } from "./receipt-theme";

const stream: Stream = {
  id: "stream-1991",
  recipient: "GRECIPIENTADDRESS123456789",
  senderAddress: "GSENDERADDRESS123456789",
  rate: "25",
  totalAmount: "500",
  schedule: "monthly",
  status: "active",
  token: "XLM",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  email: "private@example.com",
  label: "Private label",
  memo: "Private memo",
};

describe("renderReceiptPdf", () => {
  it("writes a valid PDF envelope and is deterministic", () => {
    const first = renderReceiptPdf(stream, normalizeReceiptTheme());
    const second = renderReceiptPdf(stream, normalizeReceiptTheme());
    const text = new TextDecoder().decode(first);

    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(first).toEqual(second);
    expect(text).toContain("Amount: 500 XLM");
  });

  it("keeps anonymous receipts free of unmasked addresses and PII", () => {
    const text = new TextDecoder().decode(
      renderReceiptPdf(toAnonymousReceipt(stream), normalizeReceiptTheme()),
    );

    expect(text).toContain("GREC...6789");
    expect(text).not.toContain(stream.recipient);
    expect(text).not.toContain(stream.senderAddress);
    expect(text).not.toContain(stream.email);
    expect(text).not.toContain(stream.label);
    expect(text).not.toContain(stream.memo);
  });

  it("handles absent totals, long memo, and non-ASCII labels", () => {
    const { totalAmount: _totalAmount, ...withoutTotal } = stream;
    const text = new TextDecoder().decode(
      renderReceiptPdf(
        { ...withoutTotal, label: "Café recipient", memo: "long ".repeat(10000) },
        normalizeReceiptTheme(),
      ),
    );

    expect(text).toContain("Amount: 25 XLM");
    expect(text).toContain("Caf? recipient");
    expect(text).not.toContain("long ");
  });
});
