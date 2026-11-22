/**
 * GET /api/streams/:id/withdraw/preview
 *
 * Read-only preview of withdrawing from an ended stream at the current instant.
 * Supports an optional `?amount=<raw-i128>` query parameter matching the body
 * of POST /api/streams/:id/withdraw without mutating state or emitting
 * history, audit, or webhook side effects.
 */

import { NextResponse } from "next/server";
import { streamsRateLimit } from "@/src/middleware/rateLimit";
import { db } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import {
  checkStreamOrgPolicy,
  isActorHeaderAllowed,
  requireStreamActor,
} from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { generateRequestId } from "@/lib/requestId";
import { escrowNow } from "@/app/lib/escrow-state";
import {
  parseRawI128Amount,
  previewWithdrawOutcome,
} from "@/app/lib/stream-outcome-preview";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function createErrorResponse(code: string, message: string, status: number) {
  const requestId = getCorrelationContext()?.request_id ?? generateRequestId();
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: NO_STORE_HEADERS },
  );
}

function getHeader(request: Request, name: string): string | null {
  return request.headers?.get?.(name) ?? null;
}

function getRequestUrl(request: Request, fallback: string): URL {
  try {
    return request.url ? new URL(request.url) : new URL(`http://localhost${fallback}`);
  } catch {
    return new URL(`http://localhost${fallback}`);
  }
}

function resolveCallerAddress(request: Request): string | null {
  const jwtAddress = tryAuthenticateRequest(request)?.walletAddress ?? null;
  if (jwtAddress) return jwtAddress;
  const header = getHeader(request, "Actor-Wallet-Address")?.trim() || null;
  return header && isActorHeaderAllowed() ? header : null;
}

function isOrgOwnedStream(streamId: string): boolean {
  const orgId = orgDb.streamOwnership.get(streamId);
  return Boolean(orgId && orgDb.orgs.get(orgId));
}

function authorizeWithdrawPreviewCaller(
  streamId: string,
  callerAddress: string,
  recipient: string,
): NextResponse | null {
  if (callerAddress === recipient) return null;

  const policyResult = checkStreamOrgPolicy(streamId, callerAddress, "withdraw");
  if (!policyResult) {
    return createErrorResponse(
      "RECIPIENT_AUTH_REQUIRED",
      "Only the stream recipient or an authorized org member may withdraw.",
      403,
    );
  }
  if (!policyResult.allowed) {
    if (policyResult.code === "ROLE_INSUFFICIENT") {
      return createErrorResponse(policyResult.code, policyResult.message, policyResult.httpStatus);
    }
    return createErrorResponse(
      "RECIPIENT_AUTH_REQUIRED",
      "Only the stream recipient or an authorized org member may withdraw.",
      403,
    );
  }
  return null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const path = `/api/streams/${id}/withdraw/preview`;

  // ── Rate limiting ──────────────────────────────────────────────────────────
  const rateCheck = await streamsRateLimit(request, "GET", path);
  if (!rateCheck.allowed) {
    return rateCheck.response;
  }

  // ── Authentication ─────────────────────────────────────────────────────────
  if (isOrgOwnedStream(id)) {
    const actorResult = requireStreamActor(request);
    if (actorResult instanceof NextResponse) return actorResult;
  }

  const callerAddress = resolveCallerAddress(request);
  if (!callerAddress) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "A verified caller identity is required to withdraw from a stream.",
      401,
    );
  }

  // ── Fetch stream (tenant-scoped when header is provided) ───────────────────
  const tenant = getHeader(request, "x-tenant-id")?.trim();
  const stream = tenant && db.streams.findOne ? db.streams.findOne(tenant, id) : db.streams.get(id);
  if (!stream) {
    return createErrorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
  }

  // ── Authorization ──────────────────────────────────────────────────────────
  const authError = authorizeWithdrawPreviewCaller(id, callerAddress, stream.recipient);
  if (authError) return authError;

  // ── Optional amount query parameter ────────────────────────────────────────
  const url = getRequestUrl(request, path);
  const rawAmount = url.searchParams.get("amount");
  const parsedAmount = parseRawI128Amount(rawAmount);
  if (!parsedAmount.ok) {
    return createErrorResponse("VALIDATION_ERROR", parsedAmount.message, 422);
  }

  // ── Compute read-only preview ──────────────────────────────────────────────
  const preview = previewWithdrawOutcome(stream, escrowNow(), parsedAmount.requestedAmount);
  if (!preview.ok) {
    return createErrorResponse(preview.code, preview.message, preview.httpStatus);
  }

  return NextResponse.json(
    { data: preview.data },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
