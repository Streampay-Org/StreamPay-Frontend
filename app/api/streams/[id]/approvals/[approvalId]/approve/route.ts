/**
 * POST /api/streams/:id/approvals/:approvalId/approve — Cast an approval vote
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { castApproval } from "@/app/lib/org-policy";
import { applyStreamAmendment } from "@/app/lib/amend-stream";

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message, request_id: "mock-request-id" } },
    { status },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id: streamId, approvalId } = await params;
  const actorAddress = request.headers.get("Actor-Wallet-Address");

  if (!actorAddress) {
    return errorResponse("UNAUTHORIZED", "Actor-Wallet-Address header is required.", 401);
  }

  const approval = orgDb.approvals.get(approvalId);
  if (!approval || approval.streamId !== streamId) {
    return errorResponse("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found for stream '${streamId}'.`, 404);
  }

  const org = orgDb.orgs.get(approval.orgId);
  if (!org) {
    return errorResponse("ORG_NOT_FOUND", "Organization not found.", 404);
  }

  // 1. Cast the approval
  const result = castApproval(approvalId, actorAddress, org, approval.action);

  if (!result.ok) {
    return errorResponse("VOTE_FAILED", result.error, result.httpStatus);
  }

  // 2. If threshold is met, auto-execute the action in business logic
  let amendedStream = undefined;
  if (result.thresholdMet) {
    if (approval.action === "amend" && approval.payload) {
      const amendOutcome = await applyStreamAmendment({
        streamId,
        payload: approval.payload,
        actorAddress,
        request,
      });
      if (!amendOutcome.ok) {
        if (amendOutcome.reason === "not_found") {
          return errorResponse("STREAM_NOT_FOUND", `Stream '${streamId}' not found.`, 404);
        }
        if (amendOutcome.reason === "invalid_state") {
          return errorResponse(amendOutcome.code, amendOutcome.error, 409);
        }
        return errorResponse("VALIDATION_ERROR", amendOutcome.message, 422);
      }
      amendedStream = amendOutcome.stream;
    }
  }

  return NextResponse.json({
    data: result.approval,
    ...(amendedStream ? { stream: amendedStream } : {}),
    meta: { thresholdMet: result.thresholdMet },
  });
}
