import { NextResponse } from "next/server";
import { safeJson } from "@/lib/safe-json";
import { getCorrelationContext } from "@/app/lib/logger";
import { generateRequestId } from "@/lib/requestId";

/**
 * Canonical error envelope used by every API route.
 *
 * Shape:
 * ```json
 * {
 *   "equest_id": "req_01HZ..."
 * }
 * ```
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}

export const ErrorCode = {
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  UNSUPPORTED_QUERY: "UNSUPPORTED_QUERY",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  WEBHOOK_PROCESSING_FAILED: "WEBHOOK_PROCESSING_FAILED",
  DELIVERY_FETCH_FAILED: "DELIVERY_FETCH_FAILED",
  INVALID_CURSOR: "INVALID_CURSOR",
  KMS_SIGN_FAILED: "KMS_SIGN_FAILED",
  KMS_SIGN_INVALID_INPUT: "KMS_SIGN_INVALID_INPUT",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  WALLET_CHALLENGE_FAILED: "WALLET_CHALLENGE_FAILED",
  WALLET_VERIFY_FAILED: "WALLET_VERIFY_FAILED",
  JWKS_BUILD_FAILED: "JWKS_BUILD_FAILED",
  STREAM_NOT_FOUND: "STREAM_NOT_FOUND",
  STREAM_CREATE_FAILED: "STREAM_CREATE_FAILED",
  SOROBAN_SIMULATION_FAILED: "SOROBAN_SIMULATION_FAILED",
  SOROBAN_SIMULATION_TIMEOUT: "SOROBAN_SIMULATION_TIMEOUT",
  SOROBAN_SUBMIT_TIMEOUT: "SOROBAN_SUBMIT_TIMEOUT",
  SOROBAN_SUBMIT_FAILED: "SOROBAN_SUBMIT_FAILED",
  SOROBAN_SUBMIT_BAD_AUTH: "SOROBAN_SUBMIT_BAD_AUTH",
  SOROBAN_SUBMIT_INSUFFICIENT_FUNDS: "SOROBAN_SUBMIT_INSUFFICIENT_FUNDS",
  SOROBAN_RPC_UAVAILABLE: "SOROBAN_RPC_UAVAILABLE",
  SOROBAN_RPC_TIMEOUT: "SOROBAN_RPC_TIMEOUT",
  SOROBAN_CONTRACT_NOT_FOUND: "SOROBAN_CONTRACT_NOT_FOUND",
  SOROBAN_STREAM_NOT_FOUND: "SOROBAN_STREAM_NOT_FOUND",
  SOROBAN_STREAM_ALREADY_EXISTS: "SOROBAN_STREAM_ALREADY_EXISTS",
  SOROBAN_UNKNOWN: "SOROBAN_UNKNOWN",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorResponseOptions {
  requestId?: string;
  context?: Record<string, unknown>;
}

/**
 * Resolves request ID from:
 * 1. an explicit requestId option
 * 2. getCorrelationContext()?.request_id
 * 3. generateRequestId() fallback
 */
function resolveRequestId(options?: ErrorResponseOptions): string {
  if (options?.requestId) {
    return options.requestId;
  }
  const correlationContext = getCorrelationContext();
  if (correlationContext?.request_id) {
    return correlationContext.request_id;
  }
  return generateRequestId();
}

/**
 * Build a `NextResponse` with the canonical error envelope.
 *
 * @param code    - Machine-readable error code (use `ErrorCode.*`)
 * @param message - Human-readable description safe to expose to clients
 * @param status  - HTTP status code (default 500)
 * @param context - Optional structured context to preserve (will be serialized safely)
 * @param options - Optional configuration options including explicit requestId
 */
export function errorResponse(
  code: string,
  message: string,
  status = 500,
  context?: Record<string, unknown>,
  options?: ErrorResponseOptions,
): NextResponse<ErrorEnvelope> {
  const request_id = resolveRequestId(options);
  const details = options?.context ?? context;
  const error: ErrorEnvelope["error"] = {
    code,
    message,
    request_id,
    ...(details ? { details } : {}),
  };

  return new NextResponse<ErrorEnvelope>(
    safeJson({ error }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}
