import { NextResponse } from "next/server";
import { getJwtJwks } from "@/app/lib/auth";

export async function GET() {
  return NextResponse.json(getJwtJwks(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
