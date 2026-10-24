import { NextResponse } from "next/server";

// Unknown /api/* paths fall back here and get the JSON error envelope
// the API contract promises, instead of the HTML not-found page.

function json404(path: string) {
  return NextResponse.json(
    { error: { code: "NOT_FOUND", message: "Unknown API path: " + path } },
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

const handler = async (request: Request) => {
  let path = "/api";
  try { path = new URL(request.url).pathname; } catch {}
  return json404(path);
};

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
