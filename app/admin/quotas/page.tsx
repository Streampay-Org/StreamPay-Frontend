"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Card } from "@/app/components/Card";
import { Modal } from "@/app/components/Modal";

interface Quota {
  id: string;
  scope: "org" | "user";
  subject: string;
  maxActiveStreams: number;
  maxMonthlyVolumeStroops: number;
  createdAt: string;
  updatedAt: string;
}

interface QuotaFormState {
  scope: "org" | "user";
  subject: string;
  maxActiveStreams: string;
  maxMonthlyVolumeStroops: string;
}

const EMPTY_FORM: QuotaFormState = {
  scope: "user",
  subject: "",
  maxActiveStreams: "0",
  maxMonthlyVolumeStroops: "0",
};

export default function AdminQuotasPage() {
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingQuota, setEditingQuota] = useState<Quota | null>(null);
  const [form, setForm] = useState<QuotaFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [deletingQuota, setDeletingQuota] = useState<Quota | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchQuotas = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/quotas", { credentials: "include" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? `Failed to load quotas (${res.status}).`);
        return;
      }
      const json = await res.json();
      setQuotas(Array.isArray(json.data) ? json.data : []);
    } catch {
      setError("Network error while loading quotas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuotas();
  }, [fetchQuotas]);

  const openCreateModal = () => {
    setEditingQuota(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEditModal = (quota: Quota) => {
    setEditingQuota(quota);
    setForm({
      scope: quota.scope,
      subject: quota.subject,
      maxActiveStreams: String(quota.maxActiveStreams),
      maxMonthlyVolumeStroops: String(quota.maxMonthlyVolumeStroops),
    });
    setFormError(null);
    setIsFormOpen(true);
  };

  const closeFormModal = () => {
    if (isSubmitting) return;
    setIsFormOpen(false);
    setEditingQuota(null);
    setFormError(null);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSubject = form.subject.trim();
    if (!trimmedSubject) {
      setFormError("Subject is required.");
      return;
    }

    const maxActiveStreams = Number(form.maxActiveStreams);
    const maxMonthlyVolumeStroops = Number(form.maxMonthlyVolumeStroops);
    if (!Number.isFinite(maxActiveStreams) || maxActiveStreams < 0) {
      setFormError("Max active streams must be a non-negative number.");
      return;
    }
    if (!Number.isFinite(maxMonthlyVolumeStroops) || maxMonthlyVolumeStroops < 0) {
      setFormError("Max monthly volume must be a non-negative number.");
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const url = editingQuota
        ? `/api/admin/quotas/${encodeURIComponent(editingQuota.id)}`
        : "/api/admin/quotas";
      const method = editingQuota ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          scope: form.scope,
          subject: trimmedSubject,
          maxActiveStreams,
          maxMonthlyVolumeStroops,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(json.error?.message ?? `Request failed (${res.status}).`);
        return;
      }

      setIsFormOpen(false);
      setEditingQuota(null);
      await fetchQuotas();
    } catch {
      setFormError("Network error while saving quota.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingQuota) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/admin/quotas/${encodeURIComponent(deletingQuota.id)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!res.ok && res.status !== 204) {
        const json = await res.json().catch(() => ({}));
        setError(json.error?.message ?? `Failed to delete quota (${res.status}).`);
        return;
      }

      setDeletingQuota(null);
      await fetchQuotas();
    } catch {
      setError("Network error while deleting quota.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Org &amp; User Quotas</h2>
          <p style={{ color: "var(--muted)", margin: "0.25rem 0 0", fontSize: "0.9rem" }}>
            Configure active stream limits and monthly volume caps (0 = unlimited).
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          disabled={isSubmitting}
          onClick={openCreateModal}
        >
          New Quota
        </button>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--danger, #dc2626)",
            color: "var(--danger, #dc2626)",
          }}
        >
          {error}
        </div>
      )}

      <Card padding="md">
        {loading ? (
          <p role="status" aria-live="polite">
            Loading quotas…
          </p>
        ) : quotas.length === 0 ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            No quotas configured yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "0.5rem" }}>Scope</th>
                  <th style={{ padding: "0.5rem" }}>Subject</th>
                  <th style={{ padding: "0.5rem" }}>Max Active Streams</th>
                  <th style={{ padding: "0.5rem" }}>Max Monthly Volume (stroops)</th>
                  <th style={{ padding: "0.5rem" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {quotas.map((q) => (
                  <tr key={q.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "0.5rem", textTransform: "capitalize" }}>
                      {q.scope}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      <code>{q.subject}</code>
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {q.maxActiveStreams === 0 ? "Unlimited" : q.maxActiveStreams}
                    </td>
                    <td style={{ padding: "0.5rem" }}>
                      {q.maxMonthlyVolumeStroops === 0
                        ? "Unlimited"
                        : q.maxMonthlyVolumeStroops}
                    </td>
                    <td style={{ padding: "0.5rem", display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="button"
                        disabled={isSubmitting}
                        onClick={() => openEditModal(q)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={isSubmitting}
                        onClick={() => setDeletingQuota(q)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create / Edit Modal */}
      <Modal
        isOpen={isFormOpen}
        onClose={closeFormModal}
        title={editingQuota ? "Edit Quota" : "Create Quota"}
      >
        <form onSubmit={handleFormSubmit} style={{ display: "grid", gap: "1rem" }}>
          <div>
            <label htmlFor="quota-scope" style={{ display: "block", marginBottom: "0.25rem" }}>
              Scope
            </label>
            <select
              id="quota-scope"
              value={form.scope}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  scope: e.target.value as "org" | "user",
                }))
              }
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
              }}
            >
              <option value="user">user</option>
              <option value="org">org</option>
            </select>
          </div>

          <div>
            <label htmlFor="quota-subject" style={{ display: "block", marginBottom: "0.25rem" }}>
              Subject (Org ID or Wallet Address)
            </label>
            <input
              id="quota-subject"
              type="text"
              value={form.subject}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, subject: e.target.value }))
              }
              disabled={isSubmitting}
              placeholder="G... or org-id"
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div>
            <label htmlFor="quota-max-streams" style={{ display: "block", marginBottom: "0.25rem" }}>
              Max Active Streams (0 = unlimited)
            </label>
            <input
              id="quota-max-streams"
              type="number"
              min={0}
              value={form.maxActiveStreams}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, maxActiveStreams: e.target.value }))
              }
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          <div>
            <label htmlFor="quota-max-volume" style={{ display: "block", marginBottom: "0.25rem" }}>
              Max Monthly Volume in Stroops (0 = unlimited)
            </label>
            <input
              id="quota-max-volume"
              type="number"
              min={0}
              value={form.maxMonthlyVolumeStroops}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  maxMonthlyVolumeStroops: e.target.value,
                }))
              }
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "0.5rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
              }}
            />
          </div>

          {formError && (
            <p role="alert" style={{ color: "var(--danger, #dc2626)", margin: 0, fontSize: "0.9rem" }}>
              {formError}
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button
              type="button"
              className="button"
              disabled={isSubmitting}
              onClick={closeFormModal}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="button button--primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Saving…" : editingQuota ? "Save Changes" : "Create Quota"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deletingQuota !== null}
        onClose={() => !isSubmitting && setDeletingQuota(null)}
        title="Delete Quota"
      >
        {deletingQuota && (
          <div style={{ display: "grid", gap: "1rem" }}>
            <p style={{ margin: 0 }}>
              Are you sure you want to delete the <strong>{deletingQuota.scope}</strong>{" "}
              quota for <code>{deletingQuota.subject}</code>?
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                className="button"
                disabled={isSubmitting}
                onClick={() => setDeletingQuota(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={isSubmitting}
                onClick={handleConfirmDelete}
              >
                {isSubmitting ? "Deleting…" : "Confirm Delete"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
