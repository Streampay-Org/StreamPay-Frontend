import { NextResponse } from "next/server";
import { withRouteSpan } from "@/lib/routeSpan";

export const GET = withRouteSpan("/api/healthz", () =>
  NextResponse.json({
    status: "ok",
    checked_at: new Date().toISOString(),
  }),
);
