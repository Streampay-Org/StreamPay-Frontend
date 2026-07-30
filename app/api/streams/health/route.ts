import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext, logger } from "@/app/lib/logger";

function createErrorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id } },
    { status }
  );
}

export async function GET() {
  try {
    const store = getStore();
    
    // Validate that the store is properly initialized and accessible
    if (!store.streamRepository) {
      throw new Error("Stream repository is not initialized");
    }

    const payload = {
      status: "ok",
      checked_at: new Date().toISOString(),
      dependencies: {
        database: {
          status: "ok",
          kind: store.kind,
        },
      },
    };

    logger.info("Streams health probe successful", { kind: store.kind });
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Streams health probe failed", { error: msg });
    return createErrorResponse(
      "SERVICE_UNAVAILABLE",
      "One or more dependencies are degraded.",
      503
    );
  }
}
