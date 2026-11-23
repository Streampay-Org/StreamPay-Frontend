"use client";

import React, { FormEvent, useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/app/components/EmptyState";
import { ErrorBanner } from "@/app/components/ErrorBanner";
import { LiveRegion } from "@/app/components/LiveRegion";
import { Modal } from "@/app/components/Modal";
import { Skeleton } from "@/app/components/Skeleton";
import type { StreamPayError } from "@/app/lib/errors/types";
import type { StreamPolicy } from "@/app/lib/org-types";
import { isValidStellarPublicKey } from "@/app/lib/stellar-address";
import {
  OrgApiError,
  type OrgSummary,
  toStreamPayError,
  useOrgApi,
} from "./useOrgApi";

function formatPolicySummary(policy: StreamPolicy): string {
  const approvals =
    policy.requireApprovals === 2 ? "2-step approvals" : "1-step (immediate)";
  return `v${policy.policyVersion} · ${approvals}`;
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface CreateOrgFieldErrors {
  name?: string;
  ownerWalletAddress?: string;
  form?: string;
}

export default function OrgsPage() {
  const router = useRouter();
  const { walletAddress, setWalletAddress, listOrgs, createOrg } = useOrgApi();

  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<StreamPayError | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [ownerWallet, setOwnerWallet] = useState("");
  const [fieldErrors, setFieldErrors] = useState<CreateOrgFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const nameInputId = useId();
  const nameErrorId = useId();
  const walletInputId = useId();
  const walletErrorId = useId();

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listOrgs();
      setOrgs(data);
    } catch (err) {
      setError(toStreamPayError(err));
    } finally {
      setLoading(false);
    }
  }, [listOrgs]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  const openCreateModal = useCallback(() => {
    setOrgName("");
    setOwnerWallet(walletAddress || "");
    setFieldErrors({});
    setIsCreateOpen(true);
  }, [walletAddress]);

  const closeCreateModal = useCallback(() => {
    if (submitting) return;
    setIsCreateOpen(false);
  }, [submitting]);

  const handleCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = orgName.trim();
    const trimmedWallet = ownerWallet.trim();
    const nextErrors: CreateOrgFieldErrors = {};

    if (!trimmedName) {
      nextErrors.name = "Organisation name is required.";
    }
    if (!trimmedWallet) {
      nextErrors.ownerWalletAddress = "Owner wallet address is required.";
    } else if (!isValidStellarPublicKey(trimmedWallet)) {
      nextErrors.ownerWalletAddress =
        "Enter a valid 56-character Stellar public key starting with G.";
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});

    try {
      const created = await createOrg({
        name: trimmedName,
        ownerWalletAddress: trimmedWallet,
      });
      if (!walletAddress) {
        setWalletAddress(trimmedWallet);
      }
      setLiveMessage(`Organisation ${created.name} created.`);
      setIsCreateOpen(false);
      router.push(`/orgs/${created.id}`);
    } catch (err) {
      if (err instanceof OrgApiError && err.status === 422) {
        const msg = err.message;
        if (/name/i.test(msg)) {
          setFieldErrors({ name: msg });
        } else if (/ownerWalletAddress|wallet/i.test(msg)) {
          setFieldErrors({ ownerWalletAddress: msg });
        } else {
          setFieldErrors({ form: msg });
        }
      } else {
        setFieldErrors({
          form:
            err instanceof Error
              ? err.message
              : "Could not create organisation. Please try again.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page-container" style={{ maxWidth: "1040px", margin: "0 auto", padding: "2rem 1.25rem" }}>
      <LiveRegion message={liveMessage} data-testid="orgs-live-region" />

      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 700, margin: 0 }}>
            Organisations
          </h1>
          <p style={{ color: "var(--muted)", margin: "0.25rem 0 0" }}>
            Manage team roles, stream approval policies, and per-org token allowlists.
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={openCreateModal}
        >
          Create org
        </button>
      </header>

      {error && (
        <div style={{ marginBottom: "1.5rem" }}>
          <ErrorBanner error={error} onRetry={loadOrgs} showRequestId />
        </div>
      )}

      {loading ? (
        <section
          aria-busy="true"
          aria-label="Loading organisations"
          data-testid="orgs-loading"
          style={{ display: "grid", gap: "0.75rem" }}
        >
          <span className="sr-only">Loading organisations…</span>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              style={{
                padding: "1rem 1.25rem",
                border: "1px solid var(--border)",
                borderRadius: "0.75rem",
                background: "var(--panel)",
                display: "grid",
                gridTemplateColumns: "2fr 1fr 1.5fr 1fr",
                gap: "1rem",
                alignItems: "center",
              }}
            >
              <Skeleton variant="title" width="70%" height="1.25rem" />
              <Skeleton variant="badge" width="60%" height="1rem" />
              <Skeleton variant="text" width="85%" height="1rem" />
              <Skeleton variant="text" width="65%" height="1rem" />
            </div>
          ))}
        </section>
      ) : !error && orgs.length === 0 ? (
        <EmptyState
          variant="generic"
          eyebrow="Organisations"
          title="No organisations yet"
          description="Create an organisation to manage member roles, stream policies, and per-org token allowlists."
          actionLabel="Create org"
          onAction={openCreateModal}
        />
      ) : orgs.length > 0 ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            background: "var(--panel)",
            overflowX: "auto",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th scope="col" style={{ padding: "0.875rem 1rem", fontSize: "0.875rem" }}>
                  Organisation
                </th>
                <th scope="col" style={{ padding: "0.875rem 1rem", fontSize: "0.875rem" }}>
                  Members
                </th>
                <th scope="col" style={{ padding: "0.875rem 1rem", fontSize: "0.875rem" }}>
                  Policy
                </th>
                <th scope="col" style={{ padding: "0.875rem 1rem", fontSize: "0.875rem" }}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr key={org.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "0.875rem 1rem", fontWeight: 600 }}>
                    <Link
                      href={`/orgs/${org.id}`}
                      style={{ color: "var(--accent)", textDecoration: "underline" }}
                    >
                      {org.name}
                    </Link>
                  </td>
                  <td style={{ padding: "0.875rem 1rem" }}>
                    {org.memberCount} {org.memberCount === 1 ? "member" : "members"}
                  </td>
                  <td style={{ padding: "0.875rem 1rem", color: "var(--muted)" }}>
                    {formatPolicySummary(org.policy)}
                  </td>
                  <td style={{ padding: "0.875rem 1rem", color: "var(--muted)" }}>
                    <time dateTime={org.updatedAt}>{formatDate(org.updatedAt)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal
        isOpen={isCreateOpen}
        onClose={closeCreateModal}
        title="Create organisation"
        closeLabel="Close create organisation dialog"
      >
        <form onSubmit={handleCreateSubmit} noValidate style={{ display: "grid", gap: "1rem" }}>
          {fieldErrors.form && (
            <div
              role="alert"
              style={{
                padding: "0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--danger, #dc2626)",
                color: "var(--danger, #dc2626)",
                fontSize: "0.875rem",
              }}
            >
              {fieldErrors.form}
            </div>
          )}

          <div>
            <label
              htmlFor={nameInputId}
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.375rem" }}
            >
              Organisation name
            </label>
            <input
              id={nameInputId}
              name="name"
              type="text"
              value={orgName}
              onChange={(e) => {
                setOrgName(e.target.value);
                if (fieldErrors.name) {
                  setFieldErrors((prev) => ({ ...prev, name: undefined }));
                }
              }}
              placeholder="Acme Treasury"
              required
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={fieldErrors.name ? nameErrorId : undefined}
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                background: "var(--panel)",
                color: "var(--foreground)",
                boxSizing: "border-box",
              }}
            />
            {fieldErrors.name && (
              <p
                id={nameErrorId}
                role="alert"
                style={{ color: "var(--danger, #dc2626)", fontSize: "0.8125rem", margin: "0.25rem 0 0" }}
              >
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor={walletInputId}
              style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.375rem" }}
            >
              Owner wallet address
            </label>
            <input
              id={walletInputId}
              name="ownerWalletAddress"
              type="text"
              value={ownerWallet}
              onChange={(e) => {
                setOwnerWallet(e.target.value);
                if (fieldErrors.ownerWalletAddress) {
                  setFieldErrors((prev) => ({ ...prev, ownerWalletAddress: undefined }));
                }
              }}
              placeholder="G..."
              required
              aria-invalid={Boolean(fieldErrors.ownerWalletAddress)}
              aria-describedby={fieldErrors.ownerWalletAddress ? walletErrorId : undefined}
              style={{
                width: "100%",
                padding: "0.625rem 0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                background: "var(--panel)",
                color: "var(--foreground)",
                fontFamily: "monospace",
                boxSizing: "border-box",
              }}
            />
            {fieldErrors.ownerWalletAddress && (
              <p
                id={walletErrorId}
                role="alert"
                style={{ color: "var(--danger, #dc2626)", fontSize: "0.8125rem", margin: "0.25rem 0 0" }}
              >
                {fieldErrors.ownerWalletAddress}
              </p>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "0.5rem" }}>
            <button
              type="button"
              className="button"
              onClick={closeCreateModal}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={submitting}
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </Modal>
    </main>
  );
}
