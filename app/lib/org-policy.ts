/**
 * Org policy engine — ADR-001
 *
 * Authorization layer for org-controlled streams. This module is the SOLE
 * authority for org-based AuthZ. It has no knowledge of stream business logic
 * (stream-events.ts) and no React / Next.js dependencies.
 *
 * ## Mandatory RBAC (issue #226)
 * All privileged stream lifecycle actions (start, pause, stop, settle,
 * withdraw) MUST call `requireStreamActor` before any business logic.
 *
 * The old pattern of "skip policy when Actor-Wallet-Address is absent" is
 * replaced by a hard 403 for missing actor identity. The actor is sourced
 * from the verified JWT (preferred) with the raw header as fallback for
 * internal/service callers that do not carry a JWT.
 *
 * Call order in API routes:
 *   1. requireStreamActor()  ← resolves & validates actor identity
 *   2. enforceStreamRbac()   ← checks org policy; returns 403/409 on deny
 *   3. business logic        ← only reached when (1) and (2) pass
 *
 * Future hook: replace `OrgRecord` source with on-chain signer registry
 * without changing this file's public interface.
 */

import { NextResponse } from "next/server";
import {
  OrgRecord,
  OrgRole,
  StreamPolicy,
  ApprovalAction,
  PendingApproval,
  ApprovalStatus,
} from "./org-types";
import { orgDb } from "./org-db";
import { tryAuthenticateRequest } from "./auth";
import { getCorrelationContext } from "./logger";
import { generateRequestId, isValidRequestId } from "@/lib/requestId";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Stream actions that can be governed by an org policy */
export type OrgAction = "start" | "pause" | "resume" | "settle" | "stop" | "withdraw";

export type PolicyDenied = {
  allowed: false;
  code:
    | "NOT_ORG_MEMBER"
    | "ROLE_INSUFFICIENT"
    | "CROSS_ORG_DENIED"
    | "APPROVAL_REQUIRED";
  httpStatus: 403 | 409;
  message: string;
};

export type PolicyAllowed = {
  allowed: true;
  /** True when the action must go through the two-step approval workflow */
  requiresApproval: boolean;
};

export type PolicyResult = PolicyAllowed | PolicyDenied;

// ─── Internal constants ───────────────────────────────────────────────────────

/** Keys into StreamPolicy that correspond to each OrgAction */
const ACTION_POLICY_KEY: Record<OrgAction, keyof StreamPolicy> = {
  start: "canStart",
  pause: "canPause",
  resume: "canResume",
  settle: "canSettle",
  stop: "canStop",
  withdraw: "canWithdraw",
};

/** Actions that are subject to two-step approval when requireApprovals > 1 */
const TWO_STEP_ACTIONS = new Set<OrgAction>(["settle", "stop"]);

/** Approval TTL in milliseconds (24 h) */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Actor resolution ─────────────────────────────────────────────────────────

/**
 * Creates an error response adhering to the standardized error envelope:
 * { error: { code, message, request_id } }
 */
export function createRbacErrorResponse(
  request: Request,
  code: string,
  message: string,
  status: number,
): NextResponse {
  const context = getCorrelationContext();
  let requestId = context?.request_id;
  if (!requestId) {
    const headerId = request.headers?.get?.("x-request-id");
    if (headerId && isValidRequestId(headerId)) {
      requestId = headerId;
    } else {
      requestId = generateRequestId();
    }
  }

  const res = NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: requestId,
      },
    },
    { status },
  );
  (res as any).errorDetail = { code, message };
  return res;
}

/**
 * Determines whether raw `Actor-Wallet-Address` headers are accepted.
 * Controlled by the STREAMPAY_ALLOW_ACTOR_HEADER environment variable:
 * - "true": accepts raw header
 * - "false": rejects raw header without verified JWT
 * - unset: defaults to `true` in test environment, `false` in production
 */
export function isActorHeaderAllowed(): boolean {
  const envVal = process.env.STREAMPAY_ALLOW_ACTOR_HEADER;
  if (envVal !== undefined) {
    return envVal.trim().toLowerCase() === "true";
  }
  return process.env.NODE_ENV === "test";
}

/**
 * Error thrown when an incoming request supplies both a verified JWT and an
 * `Actor-Wallet-Address` header, but the two wallet identities do not match.
 */
export class ActorMismatchError extends Error {
  readonly code = "ACTOR_MISMATCH";
  constructor(message = "Actor in JWT does not match Actor-Wallet-Address header.") {
    super(message);
    this.name = "ActorMismatchError";
  }
}

/**
 * Resolve the actor wallet address for a privileged stream action.
 *
 * Priority:
 *   1. Verified JWT `sub` claim (most trusted — cryptographically signed).
 *   2. `Actor-Wallet-Address` header (fallback, only accepted when
 *      STREAMPAY_ALLOW_ACTOR_HEADER=true, defaulting to false in production
 *      and true in test).
 *
 * Conflict check:
 *   - When both JWT and Actor-Wallet-Address are present and differ, throws
 *     ActorMismatchError (which causes requireStreamActor and enforceStreamRbac
 *     to return 403 ACTOR_MISMATCH).
 *
 * Returns `null` when neither source provides an authorized identity.
 */
export function resolveActorAddress(request: Request): string | null {
  // 1. JWT (preferred)
  const jwtActor = tryAuthenticateRequest(request);
  const jwtAddress = jwtActor?.walletAddress ?? null;

  // 2. Raw header
  const header = request.headers?.get?.("Actor-Wallet-Address") ?? null;
  const headerAddress = header?.trim() || null;

  // 3. Conflict detection: if both are present and differ, reject
  if (jwtAddress && headerAddress && jwtAddress !== headerAddress) {
    throw new ActorMismatchError(
      `Actor in JWT ('${jwtAddress}') does not match Actor-Wallet-Address header ('${headerAddress}').`,
    );
  }

  // Preferred: verified JWT identity
  if (jwtAddress) {
    return jwtAddress;
  }

  // Fallback: raw header only when allowed by flag
  if (headerAddress) {
    if (isActorHeaderAllowed()) {
      return headerAddress;
    }
    return null;
  }

  return null;
}

/**
 * Resolve the actor and return a 403 NextResponse if no identity is found or
 * if an identity conflict is detected.
 *
 * Use this at the top of privileged route handlers or through enforceStreamRbac:
 *   const actorResult = requireStreamActor(request);
 *   if (actorResult instanceof NextResponse) return actorResult;
 *   const actorAddress = actorResult;
 */
export function requireStreamActor(
  request: Request,
): string | NextResponse {
  try {
    const actor = resolveActorAddress(request);
    if (!actor) {
      return createRbacErrorResponse(
        request,
        "ACTOR_REQUIRED",
        "A verified actor identity is required for this action. " +
          "Provide a valid Bearer JWT or Actor-Wallet-Address header.",
        403,
      );
    }
    return actor;
  } catch (err) {
    if (err instanceof ActorMismatchError) {
      return createRbacErrorResponse(
        request,
        "ACTOR_MISMATCH",
        err.message,
        403,
      );
    }
    throw err;
  }
}

// ─── Core policy check ────────────────────────────────────────────────────────

/**
 * Checks whether `actorWalletAddress` is allowed to perform `action` on a
 * stream owned by `org`.
 *
 * Does NOT mutate any state. Call this before any business logic.
 *
 * Role → action matrix (from DEFAULT_STREAM_POLICY in org-types.ts):
 * ┌──────────┬───────┬────────┬─────────┬────────┐
 * │ Action   │ owner │ pauser │ settler │ viewer │
 * ├──────────┼───────┼────────┼─────────┼────────┤
 * │ start    │  ✅   │  ✅    │         │        │
 * │ pause    │  ✅   │  ✅    │         │        │
 * │ resume   │  ✅   │  ✅    │         │        │
 * │ settle   │  ✅   │        │  ✅     │        │
 * │ stop     │  ✅   │        │         │        │
 * │ withdraw │  ✅   │        │  ✅     │        │
 * └──────────┴───────┴────────┴─────────┴────────┘
 * viewer cannot perform any action.
 * settler cannot start/pause/stop.
 * pauser cannot settle/withdraw.
 */
export function checkOrgPolicy(
  org: OrgRecord,
  actorWalletAddress: string,
  action: OrgAction,
): PolicyResult {
  const member = org.members.find((m) => m.walletAddress === actorWalletAddress);

  if (!member) {
    return {
      allowed: false,
      code: "NOT_ORG_MEMBER",
      httpStatus: 403,
      message: "Actor is not a member of this organization.",
    };
  }

  const policyKey = ACTION_POLICY_KEY[action];
  const allowedRoles = org.policy[policyKey] as OrgRole[];

  if (!allowedRoles.includes(member.role)) {
    return {
      allowed: false,
      code: "ROLE_INSUFFICIENT",
      httpStatus: 403,
      message: `Role '${member.role}' is not permitted to perform '${action}'.`,
    };
  }

  const requiresApproval =
    TWO_STEP_ACTIONS.has(action) && org.policy.requireApprovals > 1;

  return { allowed: true, requiresApproval };
}

/**
 * Convenience wrapper: resolves the org for `streamId` from orgDb and calls
 * checkOrgPolicy. Returns `null` if the stream is not org-owned (caller
 * should treat the stream as individually owned — no org check needed).
 */
export function checkStreamOrgPolicy(
  streamId: string,
  actorWalletAddress: string,
  action: OrgAction,
): PolicyResult | null {
  const orgId = orgDb.streamOwnership.get(streamId);
  if (!orgId) return null; // not org-owned

  const org = orgDb.orgs.get(orgId);
  if (!org) return null; // stale reference — treat as individually owned

  return checkOrgPolicy(org, actorWalletAddress, action);
}

/**
 * Mandatory RBAC enforcement for stream lifecycle routes.
 *
 * Resolves stream ownership FIRST:
 * - Individually owned streams (not in orgDb) pass through without requiring an actor identity.
 * - Org-owned streams strictly require a verified actor identity and check org policy permissions.
 *
 * Usage in route handlers:
 *
 *   const rbacError = enforceStreamRbac(request, streamId, "settle");
 *   if (rbacError) return rbacError;
 *
 * Behaviour:
 * - Stream not org-owned   → null (pass-through)
 * - Missing actor identity → 403 ACTOR_REQUIRED
 * - Identity mismatch      → 403 ACTOR_MISMATCH
 * - Org policy denied      → 403 with policy code (e.g. ROLE_INSUFFICIENT, NOT_ORG_MEMBER)
 * - Approval required      → 409 APPROVAL_REQUIRED
 */
export function enforceStreamRbac(
  request: Request,
  streamId: string,
  action: OrgAction,
): NextResponse | null {
  // 1. Resolve ownership FIRST: individually owned streams pass through
  const orgId = orgDb.streamOwnership.get(streamId);
  if (!orgId) return null; // Individually owned stream — no org-level restriction applies

  const org = orgDb.orgs.get(orgId);
  if (!org) return null; // Stale reference — treat as individually owned

  // 2. Resolve actor — hard 403 if missing or mismatched for org-owned streams
  const actorResult = requireStreamActor(request);
  if (actorResult instanceof NextResponse) return actorResult;
  const actorAddress = actorResult;

  // 3. Org policy check
  const policyResult = checkOrgPolicy(org, actorAddress, action);

  if (!policyResult.allowed) {
    return createRbacErrorResponse(
      request,
      policyResult.code,
      policyResult.message,
      policyResult.httpStatus,
    );
  }

  if (policyResult.requiresApproval) {
    return createRbacErrorResponse(
      request,
      "APPROVAL_REQUIRED",
      "This action requires multi-sig approval. Please initiate an approval request.",
      409,
    );
  }

  return null; // ✅ allowed
}

// ─── Approval workflow ────────────────────────────────────────────────────────

export type InitiateApprovalResult =
  | { ok: true; approval: PendingApproval; autoExecuted: false }
  | { ok: false; error: string; httpStatus: 400 | 403 | 409 };

/**
 * Initiates a two-step approval for `action` on `streamId`.
 *
 * Prerequisites (caller must verify):
 *  - The stream IS org-owned.
 *  - checkOrgPolicy returned { allowed: true, requiresApproval: true }.
 *
 * Returns the created PendingApproval record (status: "pending").
 * Does NOT execute the underlying stream action — that happens via castApproval.
 */
export function initiateApproval(
  streamId: string,
  orgId: string,
  action: ApprovalAction,
  initiatedBy: string,
  requiredCount: number,
): InitiateApprovalResult {
  // Guard: no duplicate pending approval for same stream+action
  for (const existing of orgDb.approvals.values()) {
    if (
      existing.streamId === streamId &&
      existing.action === action &&
      existing.status === "pending"
    ) {
      return {
        ok: false,
        error: `A pending approval for '${action}' on stream '${streamId}' already exists (id: ${existing.id}).`,
        httpStatus: 409,
      };
    }
  }

  const now = new Date();
  const id = `appr-${crypto.randomUUID().slice(0, 8)}`;

  const approval: PendingApproval = {
    id,
    streamId,
    orgId,
    action,
    initiatedBy,
    approvals: [initiatedBy], // initiator auto-approves
    requiredCount,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };

  orgDb.approvals.set(id, approval);
  return { ok: true, approval, autoExecuted: false };
}

export type CastApprovalResult =
  | { ok: true; approval: PendingApproval; thresholdMet: boolean }
  | { ok: false; error: string; httpStatus: 400 | 403 | 404 | 409 };

/**
 * Adds `voterWalletAddress`'s approval to an existing PendingApproval.
 *
 * - Returns thresholdMet=true when `approvals.length >= requiredCount`.
 * - The caller is responsible for executing the stream action when thresholdMet.
 * - Guards: approval must be pending, not expired, voter must not have already voted.
 */
export function castApproval(
  approvalId: string,
  voterWalletAddress: string,
  org: OrgRecord,
  action: OrgAction,
): CastApprovalResult {
  const approval = orgDb.approvals.get(approvalId);

  if (!approval) {
    return { ok: false, error: `Approval '${approvalId}' not found.`, httpStatus: 404 };
  }

  if (approval.status !== "pending") {
    return {
      ok: false,
      error: `Approval '${approvalId}' is no longer pending (status: ${approval.status}).`,
      httpStatus: 409,
    };
  }

  // Lazy expiry check
  if (new Date(approval.expiresAt) <= new Date()) {
    const expired: PendingApproval = { ...approval, status: "expired" };
    orgDb.approvals.set(approvalId, expired);
    return {
      ok: false,
      error: `Approval '${approvalId}' has expired.`,
      httpStatus: 409,
    };
  }

  // Duplicate vote guard
  if (approval.approvals.includes(voterWalletAddress)) {
    return {
      ok: false,
      error: "Actor has already cast an approval for this record.",
      httpStatus: 409,
    };
  }

  // Role check: voter must have permission for the action being approved
  const policyCheck = checkOrgPolicy(org, voterWalletAddress, action);
  if (!policyCheck.allowed) {
    return {
      ok: false,
      error: policyCheck.message,
      httpStatus: policyCheck.httpStatus,
    };
  }

  const updatedApprovals = [...approval.approvals, voterWalletAddress];
  const thresholdMet = updatedApprovals.length >= approval.requiredCount;
  const newStatus: ApprovalStatus = thresholdMet ? "approved" : "pending";

  const updated: PendingApproval = {
    ...approval,
    approvals: updatedApprovals,
    status: newStatus,
  };

  orgDb.approvals.set(approvalId, updated);
  return { ok: true, approval: updated, thresholdMet };
}

