/**
 * POST /api/streams/:id/approvals/:approvalId/approve — Cast an approval vote
 *
 * When the approval threshold is met, executes the action exactly once inside withLock.
 */

import { NextResponse } from "next/server";
import { orgDb } from "@/app/lib/org-db";
import { castApproval } from "@/app/lib/org-policy";
import { withLock, db } from "@/app/lib/db";
import { executeStreamAction } from "@/app/lib/stream-executor";
import { getCorrelationContext } from "@/app/lib/logger";

function errorResponse(code: string, message: string, status: number) {
  const context = getCorrelationContext();
  return NextResponse.json(
    { error: { code, message, request_id: context?.request_id } },
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

  return withLock(streamId, async () => {
    const approval = orgDb.approvals.get(approvalId);
    if (!approval || approval.streamId !== streamId) {
      return errorResponse("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found for stream '${streamId}'.`, 404);
    }

    if (approval.status === "executed") {
      return errorResponse("APPROVAL_ALREADY_EXECUTED", `Approval '${approvalId}' has already been executed.`, 409);
    }

    if (new Date(approval.expiresAt) <= new Date()) {
      approval.status = "expired";
      orgDb.approvals.set(approvalId, approval);
      return errorResponse("APPROVAL_EXPIRED", `Approval '${approvalId}' has expired.`, 410);
    }

    const org = orgDb.orgs.get(approval.orgId);
    if (!org) {
      return errorResponse("ORG_NOT_FOUND", "Organization not found.", 404);
    }

    // 1. Cast the approval vote
    const result = castApproval(approvalId, actorAddress, org, approval.action);

    if (!result.ok) {
      return errorResponse(result.code || "VOTE_FAILED", result.error, result.httpStatus);
    }

    let updatedStream = db.streams.get(streamId);

    // 2. If threshold is met, auto-execute the action exactly once inside withLock
    if (result.thresholdMet) {
      const currentApproval = orgDb.approvals.get(approvalId)!;
      // Guard against race if already executed
      if (currentApproval.status === "executed") {
        return errorResponse("APPROVAL_ALREADY_EXECUTED", `Approval '${approvalId}' has already been executed.`, 409);
      }

      const execResult = await executeStreamAction(streamId, approval.action, {
        actor: actorAddress,
        approvalId,
        request,
      });

      if (!execResult.ok) {
        // If state no longer permits transition (e.g. state drift), mark approval failed with reason ILLEGAL_TRANSITION
        if (execResult.code === "INVALID_STREAM_STATE" || execResult.code === "ILLEGAL_TRANSITION") {
          currentApproval.status = "failed";
          currentApproval.failureReason = "ILLEGAL_TRANSITION";
          orgDb.approvals.set(approvalId, currentApproval);
          return errorResponse("ILLEGAL_TRANSITION", execResult.error, 409);
        }

        // For settlement client failure (e.g. 502), approval stays approved (not executed) and is retryable
        return errorResponse(execResult.code, execResult.error, execResult.status);
      }

      // Mark approval as executed
      const now = new Date().toISOString();
      currentApproval.status = "executed";
      currentApproval.executedAt = now;
      orgDb.approvals.set(approvalId, currentApproval);

      updatedStream = execResult.stream;
    }

    const finalApproval = orgDb.approvals.get(approvalId)!;

    return NextResponse.json({
      data: updatedStream ?? result.approval,
      approval: finalApproval,
      meta: { thresholdMet: result.thresholdMet },
    });
  });
}
