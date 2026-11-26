import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/app/lib/db";
import { withIdempotency, amendStore } from "@/app/lib/idempotency";
import { errorResponse } from "@/app/lib/errors/server";
import { validateAmendStatus } from "@/app/lib/state-machine";
import {
  checkStreamOrgPolicy,
  initiateApproval,
  requireStreamActor,
  resolveActorAddress,
} from "@/app/lib/org-policy";
import { orgDb } from "@/app/lib/org-db";
import { applyStreamAmendment, parsePositiveRate } from "@/app/lib/amend-stream";
import { streamsRateLimit, withRateLimitHeaders } from "@/src/middleware/rateLimit";
import { withRouteTimeout } from "@/src/middleware/timeout";

const AmendStreamSchema = z
  .object({
    rate: z.string().trim().min(1, "Rate must not be empty.").optional(),
    endsAt: z.string().trim().min(1, "endsAt must not be empty.").optional(),
  })
  .strict()
  .refine((data) => data.rate !== undefined || data.endsAt !== undefined, {
    message: "At least one of 'rate' or 'endsAt' must be provided.",
    path: ["rate"],
  });

function formatZodIssues(issues: z.ZodIssue[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "body";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}

/**
 * POST /api/streams/:id/amend
 *
 * Amends a draft, active, or paused stream's rate and/or end time.
 * For org-owned streams with multi-sig approval required, creates a pending
 * approval and returns 202 without mutating the stream until approved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const rateCheck = await streamsRateLimit(request, "POST", `/api/streams/${id}/amend`);
  if (!rateCheck.allowed) {
    return rateCheck.response;
  }

  let actorForScope: string | undefined;
  try {
    actorForScope = resolveActorAddress(request) ?? undefined;
  } catch {
    actorForScope = request.headers?.get?.("Actor-Wallet-Address") ?? undefined;
  }

  // Clone before withIdempotency consumes the request body stream for fingerprinting.
  const bodyClone = request.clone();

  const response = await withRouteTimeout(request, () =>
    withIdempotency(
      request,
      "amend",
      amendStore,
      async () => {
        let rawBody: unknown;
        try {
          rawBody = await bodyClone.json();
        } catch {
          return errorResponse("BAD_REQUEST", "Request body must be valid JSON.", 400);
        }

        const parsed = AmendStreamSchema.safeParse(rawBody);
        if (!parsed.success) {
          return errorResponse(
            "VALIDATION_ERROR",
            "Invalid amend stream payload.",
            422,
            { fields: formatZodIssues(parsed.error.issues) },
          );
        }

        const payload = parsed.data;
        const fieldErrors: Record<string, string> = {};

        if (payload.rate !== undefined) {
          const rateCheckResult = parsePositiveRate(payload.rate);
          if (!rateCheckResult.ok) {
            fieldErrors.rate = rateCheckResult.message;
          }
        }

        const nowMs = Date.now();
        if (payload.endsAt !== undefined) {
          const endsAtMs = Date.parse(payload.endsAt);
          if (!Number.isFinite(endsAtMs)) {
            fieldErrors.endsAt = "endsAt must be a valid ISO-8601 timestamp.";
          } else if (endsAtMs <= nowMs) {
            fieldErrors.endsAt = "endsAt must be in the future.";
          }
        }

        if (Object.keys(fieldErrors).length > 0) {
          return errorResponse(
            "VALIDATION_ERROR",
            "Invalid amend stream values.",
            422,
            { fields: fieldErrors },
          );
        }

        const stream = db.streams.get(id);
        if (!stream) {
          return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
        }

        // Authorization: require verified actor identity
        const actorResult = requireStreamActor(request);
        if (actorResult instanceof NextResponse) {
          return actorResult;
        }
        const actorAddress = actorResult;

        const orgId = orgDb.streamOwnership.get(id);
        if (orgId) {
          const policyResult = checkStreamOrgPolicy(id, actorAddress, "amend");
          if (policyResult && !policyResult.allowed) {
            return errorResponse(
              policyResult.code,
              policyResult.message,
              policyResult.httpStatus,
            );
          }

          // Validate status and startedAt before creating an approval
          const guard = validateAmendStatus(stream.status);
          if (!guard.ok) {
            return errorResponse(guard.code, guard.error, 409);
          }

          if (payload.endsAt !== undefined && stream.startTime) {
            const startMs = Date.parse(stream.startTime);
            const endsAtMs = Date.parse(payload.endsAt);
            if (Number.isFinite(startMs) && endsAtMs <= startMs) {
              return errorResponse(
                "VALIDATION_ERROR",
                "Invalid amend stream values.",
                422,
                { fields: { endsAt: "endsAt must be after startedAt." } },
              );
            }
          }

          if (policyResult?.allowed && policyResult.requiresApproval) {
            const org = orgDb.orgs.get(orgId)!;
            const initiated = initiateApproval(
              id,
              orgId,
              "amend",
              actorAddress,
              org.policy.requireApprovals,
              payload,
            );
            if (!initiated.ok) {
              return errorResponse(
                "APPROVAL_INITIATION_FAILED",
                initiated.error,
                initiated.httpStatus,
              );
            }
            return NextResponse.json(
              {
                data: initiated.approval,
                meta: { approvalRequired: true },
              },
              { status: 202 },
            );
          }
        } else {
          if (!stream.senderAddress || stream.senderAddress !== actorAddress) {
            return errorResponse(
              "FORBIDDEN",
              "Only the stream sender may amend this stream.",
              403,
            );
          }
        }

        const outcome = await applyStreamAmendment({
          streamId: id,
          payload,
          actorAddress,
          request,
        });

        if (!outcome.ok) {
          if (outcome.reason === "not_found") {
            return errorResponse("STREAM_NOT_FOUND", `Stream '${id}' not found`, 404);
          }
          if (outcome.reason === "invalid_state") {
            return errorResponse(outcome.code, outcome.error, 409);
          }
          return errorResponse("VALIDATION_ERROR", outcome.message, 422, {
            fields: { [outcome.field]: outcome.message },
          });
        }

        return NextResponse.json({ data: outcome.stream }, { status: 200 });
      },
      { resourceId: id, actorId: actorForScope },
    ),
  );

  return withRateLimitHeaders(response, rateCheck.headers);
}
