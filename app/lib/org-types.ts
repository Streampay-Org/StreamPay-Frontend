/**
 * Org-stream ownership types — ADR-001
 *
 * Canonical type definitions for org records, member roles, stream policies,
 * and the two-step approval workflow.
 *
 * Keep this file dependency-free (no React, no Next.js) so it can be used
 * in tests, API routes, and pure-logic modules without any framework coupling.
 */

// ─── Roles ───────────────────────────────────────────────────────────────────

/**
 * Roles a member can hold within an org.
 * Evaluated against StreamPolicy.can* arrays to gate stream actions.
 */
export type OrgRole = "owner" | "pauser" | "settler" | "viewer";

// ─── Policy ──────────────────────────────────────────────────────────────────

/**
 * Monotonically increasing version number.
 * Bump when the StreamPolicy shape changes and write a migration.
 */
export type PolicyVersion = 1;

/**
 * Per-org stream action policy.
 *
 * Each can* array lists the roles that may perform that action.
 * requireApprovals controls the two-step gate:
 *   1 → immediate execution (no approval record created)
 *   2 → settle and stop require a second eligible member to approve
 *
 * MVP constraint: max requireApprovals is 2.
 */
export type StreamPolicy = {
  policyVersion: PolicyVersion;
  canStart: OrgRole[];
  canPause: OrgRole[];
  canResume: OrgRole[];
  canSettle: OrgRole[];
  canStop: OrgRole[];
  canWithdraw: OrgRole[];
  /**
   * Minimum number of distinct approvals required before a two-step action
   * (settle, stop) is executed. Must be 1 or 2 in this version.
   */
  requireApprovals: 1 | 2;
};

// ─── Default policy ──────────────────────────────────────────────────────────

/**
 * Default policy applied to new orgs when none is specified.
 *
 * Role matrix:
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
 */
export const DEFAULT_STREAM_POLICY: StreamPolicy = {
  policyVersion: 1,
  canStart: ["owner", "pauser"],
  canPause: ["owner", "pauser"],
  canResume: ["owner", "pauser"],
  canSettle: ["owner", "settler"],
  canStop: ["owner"],
  canWithdraw: ["owner", "settler"],
  requireApprovals: 1,
};

// ─── Org member ───────────────────────────────────────────────────────────────

export type OrgMember = {
  /** Stellar G... public key */
  walletAddress: string;
  role: OrgRole;
  /** ISO-8601 UTC */
  addedAt: string;
};

// ─── Org record ───────────────────────────────────────────────────────────────

export type OrgRecord = {
  /** e.g. "org-acme" */
  id: string;
  name: string;
  members: OrgMember[];
  policy: StreamPolicy;
  /**
   * Per-org token allowlist (normalised token strings, e.g. "XLM", "USDC:G...").
   *
   * Behaviour:
   *   - undefined / empty array → org inherits global allowlist behaviour:
   *     open mode when the global list is disabled; global list when enabled.
   *   - Non-empty array         → ONLY these tokens may be used when creating
   *     a stream owned by this org, regardless of global allowlist state.
   *     Maps to the Soroban contract's `accepted_tokens` storage key so
   *     unexpected SAC interactions are blocked at the API layer.
   *
   * Only org owners may mutate this list via:
   *   GET    /api/orgs/:orgId/token-allowlist
   *   PUT    /api/orgs/:orgId/token-allowlist
   *   POST   /api/orgs/:orgId/token-allowlist
   *   DELETE /api/orgs/:orgId/token-allowlist/:token
   */
  tokenAllowlist?: string[];
  /** ISO-8601 UTC */
  createdAt: string;
  /** ISO-8601 UTC */
  updatedAt: string;
};

// ─── Approval workflow ────────────────────────────────────────────────────────

/** Actions that may be gated behind a two-step approval when requireApprovals > 1 */
export type ApprovalAction = "settle" | "stop";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * A pending multi-step approval for a stream action.
 *
 * Created when an eligible member initiates a two-step action.
 * Auto-transitions to "approved" (and executes the action) once
 * approvals.length >= requiredCount.
 */
export type PendingApproval = {
  id: string;
  streamId: string;
  orgId: string;
  action: ApprovalAction;
  /** Wallet address of the member who initiated the approval */
  initiatedBy: string;
  /** Ordered list of wallet addresses that have cast an approval */
  approvals: string[];
  requiredCount: number;
  status: ApprovalStatus;
  /** ISO-8601 UTC */
  createdAt: string;
  /** ISO-8601 UTC — lazy-checked; no background job enforces expiry */
  expiresAt: string;
};

// ─── Org-stream link ──────────────────────────────────────────────────────────

/**
 * Thin join record: maps a streamId to its owning org.
 * Stored separately from OrgRecord to avoid loading full org on every stream read.
 */
export type OrgStreamOwnership = {
  streamId: string;
  orgId: string;
};

// ─── Policy validation ────────────────────────────────────────────────────────

export const VALID_ORG_ROLES: readonly OrgRole[] = [
  "owner",
  "pauser",
  "settler",
  "viewer",
] as const;

export const POLICY_ACTION_KEYS = [
  "canStart",
  "canPause",
  "canResume",
  "canSettle",
  "canStop",
  "canWithdraw",
] as const;

export type PolicyActionKey = (typeof POLICY_ACTION_KEYS)[number];

export type StreamPolicyValidationResult =
  | { ok: true; policy: StreamPolicy }
  | { ok: false; errors: Record<string, string> };

/**
 * Validates an untrusted StreamPolicy payload.
 *
 * Rules:
 * - `input` must be a non-null plain object.
 * - `policyVersion` must be 1 (fixed).
 * - `requireApprovals` must be 1 or 2.
 * - Every `can*` field must be an array of valid, unique OrgRoles and must
 *   retain `"owner"` to prevent org lock-out.
 */
export function validateStreamPolicy(input: unknown): StreamPolicyValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: { policy: "Policy must be a JSON object." },
    };
  }

  const record = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const validRoleSet = new Set<string>(VALID_ORG_ROLES);

  if (record.policyVersion !== 1) {
    errors.policyVersion = "policyVersion must be 1.";
  }

  if (record.requireApprovals !== 1 && record.requireApprovals !== 2) {
    errors.requireApprovals = "requireApprovals must be 1 or 2.";
  }

  const validatedLists: Partial<Record<PolicyActionKey, OrgRole[]>> = {};

  for (const key of POLICY_ACTION_KEYS) {
    const raw = record[key];
    if (!Array.isArray(raw)) {
      errors[key] = `${key} must be an array of roles.`;
      continue;
    }

    const seen = new Set<string>();
    const roles: OrgRole[] = [];
    let fieldError: string | null = null;

    for (const item of raw) {
      if (typeof item !== "string" || !validRoleSet.has(item)) {
        fieldError = `${key} contains invalid role '${String(item)}'. Allowed roles: ${VALID_ORG_ROLES.join(", ")}.`;
        break;
      }
      if (seen.has(item)) {
        fieldError = `${key} contains duplicate role '${item}'.`;
        break;
      }
      seen.add(item);
      roles.push(item as OrgRole);
    }

    if (fieldError) {
      errors[key] = fieldError;
      continue;
    }

    if (!seen.has("owner")) {
      errors[key] = `${key} must include 'owner' to prevent organization lock-out.`;
      continue;
    }

    validatedLists[key] = roles;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    policy: {
      policyVersion: 1,
      canStart: validatedLists.canStart!,
      canPause: validatedLists.canPause!,
      canResume: validatedLists.canResume!,
      canSettle: validatedLists.canSettle!,
      canStop: validatedLists.canStop!,
      canWithdraw: validatedLists.canWithdraw!,
      requireApprovals: record.requireApprovals as 1 | 2,
    },
  };
}
