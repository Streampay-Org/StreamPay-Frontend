"use client";

import React, { FormEvent, useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ErrorBanner } from "@/app/components/ErrorBanner";
import { LiveRegion } from "@/app/components/LiveRegion";
import { Skeleton } from "@/app/components/Skeleton";
import type { StreamPayError } from "@/app/lib/errors/types";
import {
  type OrgMember,
  type OrgRole,
  POLICY_ACTION_KEYS,
  type PolicyActionKey,
  VALID_ORG_ROLES,
} from "@/app/lib/org-types";
import { isValidStellarPublicKey } from "@/app/lib/stellar-address";
import { normaliseToken } from "@/app/lib/token-allowlist";
import {
  OrgApiError,
  type OrgDetail,
  toStreamPayError,
  useOrgApi,
} from "../useOrgApi";

const POLICY_LABELS: Record<PolicyActionKey, string> = {
  canStart: "Start streams",
  canPause: "Pause streams",
  canResume: "Resume streams",
  canSettle: "Settle streams",
  canStop: "Stop streams",
  canWithdraw: "Withdraw funds",
};

const ROLE_BADGE_STYLES: Record<OrgRole, React.CSSProperties> = {
  owner: {
    background: "rgba(34, 197, 94, 0.14)",
    color: "var(--accent, #16a34a)",
    border: "1px solid rgba(34, 197, 94, 0.35)",
  },
  pauser: {
    background: "rgba(234, 179, 8, 0.14)",
    color: "#ca8a04",
    border: "1px solid rgba(234, 179, 8, 0.35)",
  },
  settler: {
    background: "rgba(59, 130, 246, 0.14)",
    color: "#2563eb",
    border: "1px solid rgba(59, 130, 246, 0.35)",
  },
  viewer: {
    background: "rgba(148, 163, 184, 0.14)",
    color: "var(--muted)",
    border: "1px solid var(--border)",
  },
};

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function OrgDetailPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = typeof params?.orgId === "string" ? params.orgId : "";

  const {
    walletAddress,
    getOrg,
    listOrgMembers,
    addOrgMember,
    getTokenAllowlist,
    addOrgAllowedToken,
    removeOrgAllowedToken,
  } = useOrgApi();

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [tokens, setTokens] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<StreamPayError | null>(null);
  const [actionError, setActionError] = useState<StreamPayError | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  // Add member form state
  const [memberWallet, setMemberWallet] = useState("");
  const [memberRole, setMemberRole] = useState<OrgRole>("viewer");
  const [memberFieldError, setMemberFieldError] = useState<string | null>(null);
  const [addingMember, setAddingMember] = useState(false);

  // Token allowlist form state
  const [tokenInput, setTokenInput] = useState("");
  const [tokenFieldError, setTokenFieldError] = useState<string | null>(null);
  const [addingToken, setAddingToken] = useState(false);
  const [confirmRemoveToken, setConfirmRemoveToken] = useState<string | null>(null);
  const [removingToken, setRemovingToken] = useState<string | null>(null);

  const memberWalletId = useId();
  const memberWalletErrorId = useId();
  const memberRoleId = useId();
  const tokenInputId = useId();
  const tokenInputErrorId = useId();

  const loadOrgData = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setNotFound(false);
    setLoadError(null);

    try {
      const [orgDetail, memberList, allowlist] = await Promise.all([
        getOrg(orgId),
        listOrgMembers(orgId),
        getTokenAllowlist(orgId),
      ]);
      setOrg(orgDetail);
      setMembers(memberList);
      setTokens(allowlist.tokens ?? []);
    } catch (err) {
      if (err instanceof OrgApiError && (err.status === 404 || err.code === "ORG_NOT_FOUND")) {
        setNotFound(true);
      } else {
        setLoadError(toStreamPayError(err));
      }
    } finally {
      setLoading(false);
    }
  }, [orgId, getOrg, listOrgMembers, getTokenAllowlist]);

  useEffect(() => {
    void loadOrgData();
  }, [loadOrgData]);

  const isOwner = useMemo(() => {
    if (!walletAddress) return false;
    return members.some(
      (m) => m.walletAddress === walletAddress && m.role === "owner",
    );
  }, [members, walletAddress]);

  const handleAddMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionError(null);
    const trimmed = memberWallet.trim();

    if (!trimmed) {
      setMemberFieldError("Wallet address is required.");
      return;
    }
    if (!isValidStellarPublicKey(trimmed)) {
      setMemberFieldError(
        "Enter a valid 56-character Stellar public key starting with G.",
      );
      return;
    }

    setMemberFieldError(null);
    setAddingMember(true);

    try {
      const { member, existed } = await addOrgMember(
        orgId,
        { walletAddress: trimmed, role: memberRole },
        walletAddress,
      );
      setMembers((prev) => {
        if (prev.some((m) => m.walletAddress === member.walletAddress)) {
          return prev;
        }
        return [...prev, member];
      });
      setMemberWallet("");
      setLiveMessage(
        existed
          ? `Member ${member.walletAddress} is already in this organisation (${member.role}).`
          : `Added ${member.walletAddress} as ${member.role}.`,
      );
    } catch (err) {
      setActionError(toStreamPayError(err));
    } finally {
      setAddingMember(false);
    }
  };

  const handleAddToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionError(null);
    const raw = tokenInput.trim();
    if (!raw) {
      setTokenFieldError("Enter a token such as XLM or USDC:G...");
      return;
    }

    let normalised: string;
    try {
      normalised = normaliseToken(raw);
    } catch (err) {
      setTokenFieldError(
        err instanceof Error ? err.message : "Invalid token format.",
      );
      return;
    }

    setTokenFieldError(null);
    setAddingToken(true);

    try {
      const result = await addOrgAllowedToken(orgId, normalised, walletAddress);
      setTokens(result.tokens ?? []);
      setTokenInput("");
      setLiveMessage(
        result.added === false
          ? `Token ${normalised} is already in the allowlist.`
          : `Added token ${normalised} to allowlist.`,
      );
    } catch (err) {
      setActionError(toStreamPayError(err));
    } finally {
      setAddingToken(false);
    }
  };

  const handleConfirmRemoveToken = async (token: string) => {
    setActionError(null);
    setRemovingToken(token);
    try {
      const result = await removeOrgAllowedToken(orgId, token, walletAddress);
      setTokens(result.tokens ?? []);
      setConfirmRemoveToken(null);
      setLiveMessage(`Removed token ${token} from allowlist.`);
    } catch (err) {
      setActionError(toStreamPayError(err));
    } finally {
      setRemovingToken(null);
    }
  };

  return (
    <main
      className="page-container"
      style={{ maxWidth: "1040px", margin: "0 auto", padding: "2rem 1.25rem" }}
    >
      <LiveRegion message={liveMessage} data-testid="org-detail-live-region" />

      <nav aria-label="Breadcrumb" style={{ marginBottom: "1rem" }}>
        <Link href="/orgs" style={{ color: "var(--accent)", textDecoration: "underline", fontSize: "0.875rem" }}>
          ← Back to organisations
        </Link>
      </nav>

      {loading ? (
        <section
          aria-busy="true"
          aria-label="Loading organisation details"
          data-testid="org-detail-loading"
          style={{ display: "grid", gap: "1rem" }}
        >
          <span className="sr-only">Loading organisation…</span>
          <Skeleton variant="title" width="40%" height="2rem" />
          <Skeleton variant="text" width="100%" height="6rem" />
          <Skeleton variant="text" width="100%" height="10rem" />
        </section>
      ) : notFound ? (
        <section
          aria-labelledby="org-not-found-title"
          style={{
            padding: "2rem",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            background: "var(--panel)",
          }}
        >
          <h1 id="org-not-found-title" style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>
            Organisation not found
          </h1>
          <p style={{ color: "var(--muted)", margin: "0 0 1.25rem" }}>
            We couldn&apos;t find an organisation with ID <code>{orgId}</code>.
          </p>
          <Link href="/orgs" className="button button--primary">
            Return to organisations
          </Link>
        </section>
      ) : loadError ? (
        <ErrorBanner error={loadError} onRetry={loadOrgData} showRequestId />
      ) : org ? (
        <div style={{ display: "grid", gap: "1.5rem" }}>
          <header>
            <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>
              {org.name}
            </h1>
            <p style={{ color: "var(--muted)", margin: "0.25rem 0 0", fontSize: "0.875rem" }}>
              ID: <code>{org.id}</code> · Updated{" "}
              <time dateTime={org.updatedAt}>{formatDate(org.updatedAt)}</time>
            </p>
          </header>

          {actionError && (
            <ErrorBanner
              error={actionError}
              onDismiss={() => setActionError(null)}
              showRequestId
            />
          )}

          {/* Policy Section */}
          <section
            aria-labelledby="org-policy-heading"
            style={{
              padding: "1.25rem",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              background: "var(--panel)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "1rem",
              }}
            >
              <h2 id="org-policy-heading" style={{ fontSize: "1.125rem", margin: 0 }}>
                Stream policy
              </h2>
              <span style={{ fontSize: "0.875rem", color: "var(--muted)" }}>
                Policy v{org.policy.policyVersion} ·{" "}
                {org.policy.requireApprovals === 2
                  ? "2-step approvals required"
                  : "1-step (immediate execution)"}
              </span>
            </div>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: "0.75rem",
                margin: 0,
              }}
            >
              {POLICY_ACTION_KEYS.map((key) => (
                <div
                  key={key}
                  style={{
                    padding: "0.75rem",
                    border: "1px solid var(--border)",
                    borderRadius: "0.5rem",
                  }}
                >
                  <dt style={{ fontSize: "0.8125rem", color: "var(--muted)", marginBottom: "0.25rem" }}>
                    {POLICY_LABELS[key]}
                  </dt>
                  <dd style={{ margin: 0, fontWeight: 600, fontSize: "0.875rem" }}>
                    {org.policy[key].join(", ")}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          {/* Members Section */}
          <section
            aria-labelledby="org-members-heading"
            style={{
              padding: "1.25rem",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              background: "var(--panel)",
            }}
          >
            <h2 id="org-members-heading" style={{ fontSize: "1.125rem", margin: "0 0 1rem" }}>
              Members ({members.length})
            </h2>

            <div style={{ overflowX: "auto", marginBottom: "1.25rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th scope="col" style={{ padding: "0.625rem 0.75rem", fontSize: "0.875rem" }}>
                      Wallet address
                    </th>
                    <th scope="col" style={{ padding: "0.625rem 0.75rem", fontSize: "0.875rem" }}>
                      Role
                    </th>
                    <th scope="col" style={{ padding: "0.625rem 0.75rem", fontSize: "0.875rem" }}>
                      Added
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr
                      key={member.walletAddress}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td
                        style={{
                          padding: "0.625rem 0.75rem",
                          fontFamily: "monospace",
                          fontSize: "0.875rem",
                          wordBreak: "break-all",
                        }}
                      >
                        {member.walletAddress}
                      </td>
                      <td style={{ padding: "0.625rem 0.75rem" }}>
                        <span
                          style={{
                            ...ROLE_BADGE_STYLES[member.role],
                            display: "inline-block",
                            padding: "0.125rem 0.5rem",
                            borderRadius: "9999px",
                            fontSize: "0.75rem",
                            fontWeight: 600,
                            textTransform: "capitalize",
                          }}
                        >
                          {member.role}
                        </span>
                      </td>
                      <td style={{ padding: "0.625rem 0.75rem", color: "var(--muted)", fontSize: "0.875rem" }}>
                        <time dateTime={member.addedAt}>{formatDate(member.addedAt)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {isOwner ? (
              <form
                onSubmit={handleAddMember}
                noValidate
                aria-label="Add organisation member"
                style={{
                  display: "grid",
                  gap: "0.75rem",
                  paddingTop: "1rem",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <h3 style={{ fontSize: "0.9375rem", margin: 0 }}>Add member</h3>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 160px auto",
                    gap: "0.75rem",
                    alignItems: "start",
                  }}
                >
                  <div>
                    <label
                      htmlFor={memberWalletId}
                      style={{ display: "block", fontSize: "0.8125rem", marginBottom: "0.25rem" }}
                    >
                      Stellar wallet address
                    </label>
                    <input
                      id={memberWalletId}
                      type="text"
                      value={memberWallet}
                      onChange={(e) => {
                        setMemberWallet(e.target.value);
                        if (memberFieldError) setMemberFieldError(null);
                      }}
                      placeholder="G..."
                      aria-invalid={Boolean(memberFieldError)}
                      aria-describedby={memberFieldError ? memberWalletErrorId : undefined}
                      style={{
                        width: "100%",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid var(--border)",
                        background: "var(--background, transparent)",
                        color: "var(--foreground)",
                        fontFamily: "monospace",
                        boxSizing: "border-box",
                      }}
                    />
                    {memberFieldError && (
                      <p
                        id={memberWalletErrorId}
                        role="alert"
                        style={{
                          color: "var(--danger, #dc2626)",
                          fontSize: "0.8125rem",
                          margin: "0.25rem 0 0",
                        }}
                      >
                        {memberFieldError}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor={memberRoleId}
                      style={{ display: "block", fontSize: "0.8125rem", marginBottom: "0.25rem" }}
                    >
                      Role
                    </label>
                    <select
                      id={memberRoleId}
                      value={memberRole}
                      onChange={(e) => setMemberRole(e.target.value as OrgRole)}
                      style={{
                        width: "100%",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid var(--border)",
                        background: "var(--background, transparent)",
                        color: "var(--foreground)",
                        boxSizing: "border-box",
                      }}
                    >
                      {VALID_ORG_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ paddingTop: "1.4rem" }}>
                    <button
                      type="submit"
                      className="button button--primary"
                      disabled={addingMember}
                    >
                      {addingMember ? "Adding…" : "Add member"}
                    </button>
                  </div>
                </div>
              </form>
            ) : (
              <p
                data-testid="members-readonly-note"
                style={{ color: "var(--muted)", fontSize: "0.875rem", margin: 0 }}
              >
                Read-only view. Only org owners can add members.
              </p>
            )}
          </section>

          {/* Token Allowlist Section */}
          <section
            aria-labelledby="org-allowlist-heading"
            style={{
              padding: "1.25rem",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              background: "var(--panel)",
            }}
          >
            <h2 id="org-allowlist-heading" style={{ fontSize: "1.125rem", margin: "0 0 0.75rem" }}>
              Token allowlist
            </h2>

            {tokens.length === 0 ? (
              <p
                data-testid="allowlist-empty"
                style={{ color: "var(--muted)", fontSize: "0.875rem", margin: "0 0 1rem" }}
              >
                No per-org tokens configured — inheriting the global token allowlist.
              </p>
            ) : (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0 0 1rem",
                  display: "grid",
                  gap: "0.5rem",
                }}
              >
                {tokens.map((token) => (
                  <li
                    key={token}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      padding: "0.625rem 0.75rem",
                      border: "1px solid var(--border)",
                      borderRadius: "0.5rem",
                    }}
                  >
                    <code style={{ fontSize: "0.875rem", wordBreak: "break-all" }}>{token}</code>
                    {isOwner && (
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        {confirmRemoveToken === token ? (
                          <>
                            <button
                              type="button"
                              className="button button--primary"
                              disabled={removingToken === token}
                              onClick={() => void handleConfirmRemoveToken(token)}
                            >
                              {removingToken === token ? "Removing…" : `Confirm remove ${token}`}
                            </button>
                            <button
                              type="button"
                              className="button"
                              disabled={removingToken === token}
                              onClick={() => setConfirmRemoveToken(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            onClick={() => setConfirmRemoveToken(token)}
                            aria-label={`Remove ${token}`}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {isOwner ? (
              <form
                onSubmit={handleAddToken}
                noValidate
                aria-label="Add allowed token"
                style={{
                  display: "grid",
                  gap: "0.5rem",
                  paddingTop: "1rem",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <label
                  htmlFor={tokenInputId}
                  style={{ fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  Add token (XLM, native, or CODE:ISSUER)
                </label>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "start" }}>
                  <div style={{ flex: 1 }}>
                    <input
                      id={tokenInputId}
                      type="text"
                      value={tokenInput}
                      onChange={(e) => {
                        setTokenInput(e.target.value);
                        if (tokenFieldError) setTokenFieldError(null);
                      }}
                      placeholder="XLM or USDC:G..."
                      aria-invalid={Boolean(tokenFieldError)}
                      aria-describedby={tokenFieldError ? tokenInputErrorId : undefined}
                      style={{
                        width: "100%",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "0.5rem",
                        border: "1px solid var(--border)",
                        background: "var(--background, transparent)",
                        color: "var(--foreground)",
                        fontFamily: "monospace",
                        boxSizing: "border-box",
                      }}
                    />
                    {tokenFieldError && (
                      <p
                        id={tokenInputErrorId}
                        role="alert"
                        style={{
                          color: "var(--danger, #dc2626)",
                          fontSize: "0.8125rem",
                          margin: "0.25rem 0 0",
                        }}
                      >
                        {tokenFieldError}
                      </p>
                    )}
                  </div>
                  <button
                    type="submit"
                    className="button button--primary"
                    disabled={addingToken}
                  >
                    {addingToken ? "Adding…" : "Add token"}
                  </button>
                </div>
              </form>
            ) : (
              <p
                data-testid="allowlist-readonly-note"
                style={{ color: "var(--muted)", fontSize: "0.875rem", margin: 0 }}
              >
                Read-only view. Only org owners can edit the token allowlist.
              </p>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
