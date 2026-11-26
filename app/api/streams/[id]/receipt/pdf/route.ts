import { NextResponse } from "next/server";
import { db } from "@/app/lib/db";
import { computeETag, ifNoneMatchMatches } from "@/app/lib/etag";
import { toAnonymousReceipt } from "@/app/lib/anon-receipt";
import { renderReceiptPdf } from "@/app/lib/receipt-pdf";
import { normalizeReceiptTheme } from "@/app/lib/receipt-theme";
import {
  resolveRequestActor,
  resolveRequestTenant,
  visibleTo,
} from "@/app/lib/stream-visibility";
import { resolveRequestId } from "@/lib/requestId";

type Context = { params: Promise<{ id: string }> };

const CACHE_CONTROL = "private, max-age=0, must-revalidate";

function errorResponse(
  request: Request,
  code: string,
  message: string,
  status: number,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: resolveRequestId(request.headers),
      },
    },
    { status },
  );
}

export async function GET(request: Request, { params }: Context) {
  const actor = resolveRequestActor(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Authentication is required", 401);
  }

  const { id } = await params;
  const tenant = resolveRequestTenant(request);
  const stream = db.streams.get(id);
  if (!stream || !visibleTo(actor, tenant)(stream)) {
    return errorResponse(request, "STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  const url = new URL(request.url);
  const theme = normalizeReceiptTheme({
    logoUrl: url.searchParams.get("logoUrl"),
    accentColor: url.searchParams.get("accentColor"),
    message: url.searchParams.get("message"),
  });
  const anonymous = url.searchParams.get("anonymous") === "true";
  const receiptData = anonymous ? toAnonymousReceipt(stream) : stream;
  const pdf = renderReceiptPdf(receiptData, theme);
  const filenameId = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const etag = computeETag(tenant, Buffer.from(pdf).toString("base64"));
  const headers = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="streampay-receipt-${filenameId}.pdf"`,
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
  };
  if (ifNoneMatchMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }

  const body = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(body).set(pdf);
  return new NextResponse(body, { headers });
}
