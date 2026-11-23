"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Card } from "@/app/components/Card";
import { ErrorBanner } from "@/app/components/ErrorBanner";
import { useToast } from "@/app/hooks/useToast";
import type { StreamPayError, ErrorCode, ErrorCategory } from "@/app/lib/errors/types";
import {
  VALID_ORG_ROLES,
  validateStreamPolicy,
  type OrgRole,
  type PolicyActionKey,
  type StreamPolicy,
} from "@/app/lib/org-types";

interface PolicyApiResponse {
  data?: {
    orgId: string;
    policy: StreamPolicy;
    updatedAt: string;
  };
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: {
      fieldErrors?: Record<string, string>;
    };
  };
}

const ACTION_ROWS: { key: PolicyActionKey; label: string; description: string }[] = [
  { key: "canStart", label: "Start", description: "Start a new or scheduled stream" },
  { key: "canPause", label: "Pause", description: "Temporarily pause an active stream" },
  { key: "canResume", label: "Resume", description: "Resume a paused stream" },
  { key: "canSettle", label: "Settle", description: "Settle accrued funds on a stream" },
  { key: "canStop", label: "Stop", description: "Permanently stop a stream" },
  { key: "canWithdraw", label: "Withdraw", description: "Withdraw settled stream funds" },
];

const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  pauser: "Pauser",
  settler: "Settler",
  viewer: "Viewer",
};

function clonePolicy(policy: StreamPolicy): StreamPolicy {
  return {
    policyVersion: policy.policyVersion,
    canStart: [...policy.canStart],
    canPause: [...policy.canPause],
    canResume: [...policy.canResume],
    canSettle: [...policy.canSettle],
    canStop: [...policy.canStop],
    canWithdraw: [...policy.canWithdraw],
    requireApprovals: policy.requireApprovals,
  };
}

function buildStreamPayError(
  status: number,
  apiError?: PolicyApiResponse["error"],
  fallbackMessage = "An unexpected error occurred.",
): StreamPayError {
  const rawCode = apiError?.code ?? "UNKNOWN_ERROR";
  let code: ErrorCode = "UNKNOWN_ERROR";
  let category: ErrorCategory = "unknown";
  let title = "Error";
  let retryable = false;

  if (status === 409 || rawCode === "STATE_CONFLICT") {
    code = "CONFLICT";
    category = "client";
    title = "Policy Modified Concurrently";
    retryable = true;
  } else if (status === 403 || rawCode === "FORBIDDEN" || rawCode === "ACTOR_REQUIRED") {
    code = "FORBIDDEN";
    category = "auth";
    title = "Permission Denied";
  } else if (status === 404 || rawCode === "ORG_NOT_FOUND") {
    code = "NOT_FOUND";
    category = "client";
    title = "Organization Not Found";
  } else if (status === 400 || rawCode === "VALIDATION_ERROR") {
    code = "VALIDATION_ERROR";
    category = "validation";
    title = "Invalid Policy";
  } else if (status >= 500) {
    code = "INTERNAL_ERROR";
    category = "server";
    title = "Server Error";
    retryable = true;
  }

  return {
    type: `urn:streampay:error:${code.toLowerCase()}`,
    code,
    title,
    detail: apiError?.message ?? fallbackMessage,
    status,
    requestId: apiError?.request_id,
    category,
    retry: { retryable },
    meta: apiError?.details?.fieldErrors
      ? { fieldErrors: apiError.details.fieldErrors }
      : undefined,
  };
}

export default function OrgPolicyPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId ?? "";
  const toast = useToast();

  const [policy, setPolicy] = useState<StreamPolicy | null>(null);
  const [initialPolicy, setInitialPolicy] = useState<StreamPolicy | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<StreamPayError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isConflict, setIsConflict] = useState(false);

  const loadPolicy = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setServerError(null);
    setFieldErrors({});
    setIsConflict(false);

    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/policy`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const json = (await res.json()) as PolicyApiResponse;

      if (!res.ok || !json.data?.policy) {
        setServerError(
          buildStreamPayError(res.status, json.error, "Failed to load organization policy."),
        );
        setPolicy(null);
        setInitialPolicy(null);
        return;
      }

      const loaded = clonePolicy(json.data.policy);
      setPolicy(loaded);
      setInitialPolicy(clonePolicy(loaded));
      setEtag(res.headers.get("ETag"));
    } catch {
      setServerError(
        buildStreamPayError(500, undefined, "Network error while loading organization policy."),
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const handleRoleToggle = (actionKey: PolicyActionKey, role: OrgRole) => {
    if (!policy) return;
    const current = policy[actionKey];
    const nextRoles = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];

    const updated: StreamPolicy = {
      ...policy,
      [actionKey]: nextRoles,
    };
    setPolicy(updated);
    setServerError(null);
    setIsConflict(false);

    const validation = validateStreamPolicy(updated);
    setFieldErrors(validation.ok ? {} : validation.errors);
  };

  const handleApprovalsChange = (value: string) => {
    if (!policy) return;
    const parsed = Number(value) as 1 | 2;
    const updated: StreamPolicy = {
      ...policy,
      requireApprovals: parsed,
    };
    setPolicy(updated);
    setServerError(null);
    setIsConflict(false);

    const validation = validateStreamPolicy(updated);
    setFieldErrors(validation.ok ? {} : validation.errors);
  };

  const handleReset = () => {
    if (!initialPolicy) return;
    setPolicy(clonePolicy(initialPolicy));
    setFieldErrors({});
    setServerError(null);
    setIsConflict(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policy || !orgId) return;

    const validation = validateStreamPolicy(policy);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }

    setSaving(true);
    setServerError(null);
    setFieldErrors({});
    setIsConflict(false);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (etag) {
        headers["If-Match"] = etag;
      }

      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/policy`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ policy: validation.policy }),
      });

      const json = (await res.json()) as PolicyApiResponse;

      if (!res.ok) {
        if (res.status === 409) {
          setIsConflict(true);
        }
        if (json.error?.details?.fieldErrors) {
          setFieldErrors(json.error.details.fieldErrors);
        }
        setServerError(
          buildStreamPayError(res.status, json.error, "Failed to save organization policy."),
        );
        return;
      }

      if (json.data?.policy) {
        const saved = clonePolicy(json.data.policy);
        setPolicy(saved);
        setInitialPolicy(clonePolicy(saved));
      }
      setEtag(res.headers.get("ETag"));
      toast.success("Stream policy saved.");
    } catch {
      setServerError(
        buildStreamPayError(500, undefined, "Network error while saving organization policy."),
      );
    } finally {
      setSaving(false);
    }
  };

  const hasValidationErrors = Object.keys(fieldErrors).length > 0;
  const isDirty =
    policy !== null &&
    initialPolicy !== null &&
    JSON.stringify(policy) !== JSON.stringify(initialPolicy);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Stream Policy</h1>
        <p className="text-sm text-gray-600 mt-1">
          Configure which organization roles can perform stream lifecycle actions and how many
          approvals are required for two-step actions.
        </p>
      </header>

      {serverError && (
        <div className="space-y-2">
          <ErrorBanner
            error={serverError}
            showRequestId
            onDismiss={() => {
              setServerError(null);
              setIsConflict(false);
            }}
            onRetry={isConflict ? () => void loadPolicy() : undefined}
          />
          {isConflict && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void loadPolicy()}
                className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 bg-white hover:bg-gray-50"
              >
                Reload latest policy
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <Card padding="lg">
          <p role="status" aria-live="polite" className="text-sm text-gray-600">
            Loading stream policy...
          </p>
        </Card>
      ) : policy ? (
        <form onSubmit={handleSave} noValidate aria-label="Stream policy editor">
          <Card padding="lg" className="space-y-6">
            <section aria-labelledby="role-matrix-heading">
              <h2 id="role-matrix-heading" className="text-lg font-semibold mb-3">
                Role Permissions Matrix
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="py-2 pr-4 text-left font-medium">
                        Action
                      </th>
                      {VALID_ORG_ROLES.map((role) => (
                        <th key={role} scope="col" className="py-2 px-3 text-center font-medium">
                          {ROLE_LABELS[role]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ACTION_ROWS.map((row) => {
                      const rowError = fieldErrors[row.key];
                      const errorId = `${row.key}-error`;
                      return (
                        <tr key={row.key} className="border-b last:border-b-0">
                          <th scope="row" className="py-3 pr-4 text-left font-normal">
                            <div className="font-medium">{row.label}</div>
                            <div className="text-xs text-gray-500">{row.description}</div>
                            {rowError && (
                              <p
                                id={errorId}
                                role="alert"
                                className="mt-1 text-xs font-medium text-red-700"
                              >
                                {rowError}
                              </p>
                            )}
                          </th>
                          {VALID_ORG_ROLES.map((role) => {
                            const checked = policy[row.key].includes(role);
                            return (
                              <td key={role} className="py-3 px-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleRoleToggle(row.key, role)}
                                  aria-label={`Allow ${role} to ${row.label.toLowerCase()}`}
                                  aria-invalid={rowError ? "true" : "false"}
                                  aria-describedby={rowError ? errorId : undefined}
                                  disabled={saving}
                                  className="h-4 w-4 cursor-pointer"
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section aria-labelledby="approvals-heading" className="space-y-2">
              <h2 id="approvals-heading" className="text-lg font-semibold">
                Approval Threshold
              </h2>
              <div className="max-w-sm">
                <label
                  htmlFor="require-approvals"
                  className="block text-sm font-medium mb-1"
                >
                  Required approvals for settle &amp; stop
                </label>
                <select
                  id="require-approvals"
                  value={policy.requireApprovals}
                  onChange={(e) => handleApprovalsChange(e.target.value)}
                  disabled={saving}
                  aria-invalid={fieldErrors.requireApprovals ? "true" : "false"}
                  aria-describedby={
                    fieldErrors.requireApprovals ? "require-approvals-error" : undefined
                  }
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value={1}>1 — Immediate execution</option>
                  <option value={2}>2 — Two-step approval required</option>
                </select>
                {fieldErrors.requireApprovals && (
                  <p
                    id="require-approvals-error"
                    role="alert"
                    className="mt-1 text-xs font-medium text-red-700"
                  >
                    {fieldErrors.requireApprovals}
                  </p>
                )}
              </div>
            </section>

            <div className="flex items-center justify-end gap-3 pt-2 border-t">
              <button
                type="button"
                onClick={handleReset}
                disabled={saving || !isDirty}
                className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                Reset
              </button>
              <button
                type="submit"
                disabled={saving || hasValidationErrors}
                className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Policy"}
              </button>
            </div>
          </Card>
        </form>
      ) : null}
    </main>
  );
}
