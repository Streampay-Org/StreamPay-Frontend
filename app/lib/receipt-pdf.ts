import type { Stream } from "@/app/types/openapi";
import type { AnonymousReceipt } from "./anon-receipt";
import type { ReceiptTheme } from "./receipt-theme";

type ReceiptData = Stream | AnonymousReceipt;

function isAnonymousReceipt(receipt: ReceiptData): receipt is AnonymousReceipt {
  return "readonly" in receipt && receipt.readonly === true;
}

function pdfString(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 120)
    .replace(/([\\()])/g, "\\$1");
}

function rgbColor(hex: string): string {
  const normalized = hex.slice(1);
  const full = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  const channels = [0, 2, 4].map((index) =>
    (parseInt(full.slice(index, index + 2), 16) / 255).toFixed(3),
  );
  return `${channels.join(" ")} rg`;
}

function createPdf(content: string): Uint8Array {
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  let length = parts[0].length;

  const addObject = (number: number, body: string) => {
    offsets[number] = length;
    const object = `${number} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    length += object.length;
  };

  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  );
  addObject(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  addObject(
    5,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  );

  const xrefOffset = length;
  const xref = [
    "xref\n0 6\n",
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  ].join("");

  return new TextEncoder().encode(parts.join("") + xref);
}

/** Render a deterministic, single-page receipt PDF using only built-in fonts. */
export function renderReceiptPdf(
  receiptData: ReceiptData,
  theme: ReceiptTheme,
): Uint8Array {
  const anonymous = isAnonymousReceipt(receiptData);
  const recipient = anonymous ? receiptData.recipientMasked : receiptData.recipient;
  const sender = anonymous
    ? receiptData.senderMasked
    : receiptData.senderAddress ?? undefined;
  const amount = anonymous
    ? receiptData.rate
    : receiptData.totalAmount ?? receiptData.rate;

  const lines = [
    `Stream ID: ${receiptData.id}`,
    `Recipient: ${recipient}`,
    ...(sender ? [`Sender: ${sender}`] : []),
    ...(!anonymous && receiptData.label ? [`Recipient label: ${receiptData.label}`] : []),
    `Amount: ${amount} ${receiptData.token}`,
    `Status: ${receiptData.status}`,
    `Created: ${receiptData.createdAt}`,
    `Updated: ${receiptData.updatedAt}`,
    ...(theme.message ? [`Message: ${theme.message}`] : []),
  ];

  const commands = [
    `${rgbColor(theme.accentColor)} 0 780 612 12 re f`,
    `0 0 0 rg BT /F1 18 Tf 50 746 Td (StreamPay Receipt) Tj ET`,
    ...lines.map(
      (line, index) =>
        `0 0 0 rg BT /F1 11 Tf 50 ${710 - index * 24} Td (${pdfString(line)}) Tj ET`,
    ),
  ];

  return createPdf(`${commands.join("\n")}\n`);
}
