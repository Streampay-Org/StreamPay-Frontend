import { NextResponse } from "next/server";
import { getCorrelationContext, logger } from "@/app/lib/logger";

export type ReconciliationHealthStatus = "ok" | "degraded";

export type ReconciliationHealthCheck = {
  status: ReconciliationHealthStatus;
  message?: string;
  checked_at: string;
};

export type ReconciliationHealthReport = {
  status: ReconciliationHealthStatus;
  checks: {
    database: ReconciliationHealthCheck;
    onchain: ReconciliationHealthCheck;
  };
};

function createCheck(status: ReconciliationHealthStatus, checkedAt: string, message?: string): ReconciliationHealthCheck {
  return {
    status,
    checked_at: checkedAt,
    ...(message ? { message } : {}),
  };
}

export async function GET(request: Request) {
  const context = getCorrelationContext();
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  const databaseCheck = createCheck("ok", checkedAt);
  const onchainCheck = createCheck("ok", checkedAt);

  try {
    const dbReady = process.env.RECONCILIATION_DB_READY === "true";
    if (!dbReady) {
      throw new Error("reconciliation database dependency is not ready");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconciliation dependency error";
    databaseCheck.status = "degraded";
    databaseCheck.message = message;
  }

  try {
    const rpcReady = process.env.RECONCILIATION_RPC_READY === "true";
    if (!rpcReady) {
      throw new Error("reconciliation on-chain dependency is not ready");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reconciliation dependency error";
    onchainCheck.status = "degraded";
    onchainCheck.message = message;
  }

  const report: ReconciliationHealthReport = {
    status: databaseCheck.status === "ok" && onchainCheck.status === "ok" ? "ok" : "degraded",
    checks: {
      database: databaseCheck,
      onchain: onchainCheck,
    },
  };

  logger.info("reconciliation health probe executed", {
    method: request.method,
    path: new URL(request.url).pathname,
    status: report.status,
    duration_ms: Date.now() - startedAt,
    request_id: context?.request_id,
    correlation_id: context?.correlation_id,
  });

  return NextResponse.json(report, { status: report.status === "ok" ? 200 : 503 });
}
