"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Card } from "@/app/components/Card";
import { Modal } from "@/app/components/Modal";
import { isValidStellarPublicKey } from "@/app/lib/stellar-address";

const MIN_REASON_LENGTH = 10;

interface PauseState {
  paused: boolean;
  pausedAt: string | null;
  adminAddress: string;
}

interface CircuitBreakerItem {
  open: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface CircuitBreakersState {
  indexer: CircuitBreakerItem;
  webhook: CircuitBreakerItem;
}

interface StreamHealthState {
  total: number;
  byStatus: Record<string, number>;
  failureRatePct: number;
  oldestStuckAt: string | null;
  checkedAt: string;
}

interface JobQueueSnapshot {
  count: number;
  capacity?: number;
  deadLettered: number;
}

interface JobsState {
  queues: Record<string, JobQueueSnapshot>;
  totals: {
    total: number;
    pending: number;
    failed: number;
    deadLettered: number;
  };
}

type PendingAction =
  | {
      type: "pause";
      nextPaused: boolean;
      title: string;
      blastRadius: string;
    }
  | {
      type: "circuit-breaker";
      target: "indexer" | "webhook";
      nextOpen: boolean;
      title: string;
      blastRadius: string;
    }
  | {
      type: "pause-by-sender";
      senderAddress: string;
      title: string;
      blastRadius: string;
    };

export default function AdminDashboardPage() {
  const [pauseState, setPauseState] = useState<PauseState | null>(null);
  const [breakers, setBreakers] = useState<CircuitBreakersState | null>(null);
  const [streamHealth, setStreamHealth] = useState<StreamHealthState | null>(null);
  const [jobs, setJobs] = useState<JobsState | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Pause by sender form
  const [senderAddress, setSenderAddress] = useState("");
  const [senderError, setSenderError] = useState<string | null>(null);

  // Confirmation modal state
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastAuditRequestId, setLastAuditRequestId] = useState<string | null>(null);
  const [lastActionSummary, setLastActionSummary] = useState<string | null>(null);

  const fetchDashboardData = useCallback(async () => {
    setPageError(null);
    setJobsError(null);

    try {
      const [pauseRes, cbRes, healthRes, jobsRes] = await Promise.all([
        fetch("/api/admin/pause", { credentials: "include" }),
        fetch("/api/admin/circuit-breaker", { credentials: "include" }),
        fetch("/api/admin/streams/health", { credentials: "include" }),
        fetch("/api/admin/jobs", { credentials: "include" }),
      ]);

      if (pauseRes.ok) {
        const json = await pauseRes.json();
        setPauseState(json.data ?? null);
      } else {
        setPageError("Failed to load global pause state.");
      }

      if (cbRes.ok) {
        const json = await cbRes.json();
        setBreakers(json.data ?? null);
      } else {
        setPageError((prev) => prev ?? "Failed to load circuit breaker state.");
      }

      if (healthRes.ok) {
        const json = await healthRes.json();
        setStreamHealth(json.data?.health ?? null);
      } else {
        setPageError((prev) => prev ?? "Failed to load stream health.");
      }

      if (jobsRes.ok) {
        const json = await jobsRes.json();
        setJobs(json.data ?? null);
      } else {
        setJobs(null);
        setJobsError("Job queue metrics unavailable (requires admin JWT or internal auth).");
      }
    } catch {
      setPageError("Failed to load admin dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const openPauseModal = () => {
    const nextPaused = !(pauseState?.paused ?? false);
    setActionError(null);
    setReason("");
    setPendingAction({
      type: "pause",
      nextPaused,
      title: nextPaused ? "Activate Global Pause" : "Lift Global Pause",
      blastRadius: nextPaused
        ? "Blast radius: All users. Blocks create_stream and withdraw across the entire platform (503 ContractPaused). Cancel and settle remain available."
        : "Blast radius: All users. Resumes create_stream and withdraw operations platform-wide.",
    });
  };

  const openCircuitBreakerModal = (target: "indexer" | "webhook") => {
    const currentlyOpen = breakers?.[target]?.open ?? false;
    const nextOpen = !currentlyOpen;
    setActionError(null);
    setReason("");
    setPendingAction({
      type: "circuit-breaker",
      target,
      nextOpen,
      title: nextOpen
        ? `Trip ${target} Circuit Breaker`
        : `Reset ${target} Circuit Breaker`,
      blastRadius: nextOpen
        ? `Blast radius: ${target} subsystem. Halts all ${target} event dispatch until manually reset.`
        : `Blast radius: ${target} subsystem. Resumes normal ${target} event dispatch.`,
    });
  };

  const handlePauseBySenderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = senderAddress.trim();
    if (!isValidStellarPublicKey(trimmed)) {
      setSenderError("Enter a valid Stellar public key (56-character G… address).");
      return;
    }
    setSenderError(null);
    setActionError(null);
    setReason("");
    setPendingAction({
      type: "pause-by-sender",
      senderAddress: trimmed,
      title: "Pause Streams by Sender",
      blastRadius: `Blast radius: All active streams created by sender ${trimmed} will be immediately paused.`,
    });
  };

  const handleConfirmAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingAction) return;

    const trimmedReason = reason.trim();
    if (trimmedReason.length < MIN_REASON_LENGTH) {
      setActionError(`Reason must be at least ${MIN_REASON_LENGTH} characters.`);
      return;
    }

    setIsSubmitting(true);
    setActionError(null);

    try {
      let url = "";
      let body: Record<string, unknown> = {};
      let summary = "";

      if (pendingAction.type === "pause") {
        url = "/api/admin/pause";
        body = { paused: pendingAction.nextPaused, reason: trimmedReason };
        summary = pendingAction.nextPaused
          ? "Global pause activated."
          : "Global pause lifted.";
      } else if (pendingAction.type === "circuit-breaker") {
        url = "/api/admin/circuit-breaker";
        body = {
          target: pendingAction.target,
          open: pendingAction.nextOpen,
          reason: trimmedReason,
        };
        summary = `${pendingAction.target} circuit breaker ${pendingAction.nextOpen ? "tripped" : "reset"}.`;
      } else {
        url = "/api/admin/pause-by-sender";
        body = {
          senderAddress: pendingAction.senderAddress,
          reason: trimmedReason,
        };
        summary = `Paused active streams for ${pendingAction.senderAddress}.`;
      }

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setActionError(json.error?.message ?? `Request failed (${res.status}).`);
        return;
      }

      setLastAuditRequestId(json.auditRequestId ?? null);
      setLastActionSummary(summary);
      if (pendingAction.type === "pause-by-sender") {
        setSenderAddress("");
      }
      setPendingAction(null);
      setReason("");
      await fetchDashboardData();
    } catch {
      setActionError("Network error while executing admin action.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const closeModal = () => {
    if (isSubmitting) return;
    setPendingAction(null);
    setActionError(null);
    setReason("");
  };

  if (loading) {
    return (
      <p role="status" aria-live="polite">
        Loading admin dashboard…
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {pageError && (
        <div
          role="alert"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--danger, #dc2626)",
            color: "var(--danger, #dc2626)",
          }}
        >
          {pageError}
        </div>
      )}

      {lastActionSummary && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border)",
            backgroundColor: "var(--panel-elevated)",
          }}
        >
          <strong>{lastActionSummary}</strong>
          {lastAuditRequestId && (
            <span style={{ marginLeft: "0.75rem", color: "var(--muted)" }}>
              Audit Request ID: <code>{lastAuditRequestId}</code>
            </span>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "1rem",
        }}
      >
        {/* Global Pause Card */}
        <Card padding="lg">
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Global Pause</h2>
          <p style={{ margin: "0.5rem 0" }}>
            Status:{" "}
            <strong>{pauseState?.paused ? "PAUSED" : "ACTIVE"}</strong>
          </p>
          {pauseState?.pausedAt && (
            <p style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
              Last updated: {pauseState.pausedAt}
            </p>
          )}
          <button
            type="button"
            className="button button--primary"
            disabled={isSubmitting}
            onClick={openPauseModal}
            style={{ marginTop: "0.75rem" }}
          >
            {pauseState?.paused ? "Lift Global Pause" : "Activate Global Pause"}
          </button>
        </Card>

        {/* Circuit Breakers Card */}
        <Card padding="lg">
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Circuit Breakers</h2>
          {(["indexer", "webhook"] as const).map((target) => {
            const state = breakers?.[target];
            const isOpen = state?.open ?? false;
            return (
              <div
                key={target}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div>
                  <strong style={{ textTransform: "capitalize" }}>{target}</strong>
                  <div style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
                    {isOpen ? "Tripped (Open)" : "Healthy (Closed)"}
                  </div>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={isSubmitting}
                  onClick={() => openCircuitBreakerModal(target)}
                >
                  {isOpen ? `Reset ${target}` : `Trip ${target}`}
                </button>
              </div>
            );
          })}
        </Card>

        {/* Stream Health Card */}
        <Card padding="lg">
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Stream Health</h2>
          {streamHealth ? (
            <div style={{ fontSize: "0.9rem", display: "grid", gap: "0.35rem" }}>
              <div>
                Total Streams: <strong>{streamHealth.total}</strong>
              </div>
              <div>
                Failure Rate: <strong>{streamHealth.failureRatePct}%</strong>
              </div>
              <div>
                Oldest Stuck:{" "}
                <strong>{streamHealth.oldestStuckAt ?? "None"}</strong>
              </div>
              <div style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                By status:{" "}
                {Object.entries(streamHealth.byStatus)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ") || "none"}
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--muted)" }}>No health data available.</p>
          )}
        </Card>

        {/* Job Queue Depth Card */}
        <Card padding="lg">
          <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Job Queue Depth</h2>
          {jobs ? (
            <div style={{ fontSize: "0.9rem", display: "grid", gap: "0.35rem" }}>
              <div>
                Total: <strong>{jobs.totals.total}</strong> (Pending:{" "}
                {jobs.totals.pending}, Failed: {jobs.totals.failed}, Dead-lettered:{" "}
                {jobs.totals.deadLettered})
              </div>
              {Object.entries(jobs.queues).map(([name, q]) => (
                <div key={name} style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
                  {name}: {q.count} queued ({q.deadLettered} dead-lettered)
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
              {jobsError ?? "No job queue data available."}
            </p>
          )}
        </Card>
      </div>

      {/* Pause by Sender Form */}
      <Card padding="lg">
        <h2 style={{ fontSize: "1.1rem", marginTop: 0 }}>Pause Streams by Sender</h2>
        <p style={{ color: "var(--muted)", fontSize: "0.9rem", marginBottom: "1rem" }}>
          Emergency pause all active streams belonging to a specific Stellar sender address.
        </p>
        <form
          onSubmit={handlePauseBySenderSubmit}
          style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-start" }}
        >
          <div style={{ flex: "1 1 320px" }}>
            <label htmlFor="sender-address-input" style={{ display: "block", marginBottom: "0.25rem" }}>
              Sender Stellar Address
            </label>
            <input
              id="sender-address-input"
              type="text"
              value={senderAddress}
              onChange={(e) => {
                setSenderAddress(e.target.value);
                if (senderError) setSenderError(null);
              }}
              placeholder="G..."
              disabled={isSubmitting}
              style={{
                width: "100%",
                padding: "0.5rem 0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
              }}
            />
            {senderError && (
              <p role="alert" style={{ color: "var(--danger, #dc2626)", fontSize: "0.85rem", marginTop: "0.25rem" }}>
                {senderError}
              </p>
            )}
          </div>
          <button
            type="submit"
            className="button button--primary"
            disabled={isSubmitting || senderAddress.trim().length === 0}
            style={{ marginTop: "1.6rem" }}
          >
            Pause Sender Streams
          </button>
        </form>
      </Card>

      {/* Confirmation Modal */}
      <Modal
        isOpen={pendingAction !== null}
        onClose={closeModal}
        title={pendingAction?.title ?? "Confirm Admin Action"}
      >
        {pendingAction && (
          <form onSubmit={handleConfirmAction} style={{ display: "grid", gap: "1rem" }}>
            <div
              role="note"
              style={{
                padding: "0.75rem",
                borderRadius: "0.5rem",
                border: "1px solid var(--border)",
                fontSize: "0.9rem",
              }}
            >
              {pendingAction.blastRadius}
            </div>

            <div>
              <label htmlFor="admin-action-reason" style={{ display: "block", marginBottom: "0.35rem" }}>
                Audit Reason (minimum {MIN_REASON_LENGTH} characters)
              </label>
              <textarea
                id="admin-action-reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={isSubmitting}
                placeholder="Describe the incident or operational reason for this action…"
                style={{
                  width: "100%",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border)",
                }}
              />
              <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "0.25rem" }}>
                {reason.trim().length}/{MIN_REASON_LENGTH} minimum characters
              </div>
            </div>

            {actionError && (
              <p role="alert" style={{ color: "var(--danger, #dc2626)", margin: 0, fontSize: "0.9rem" }}>
                {actionError}
              </p>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                className="button"
                disabled={isSubmitting}
                onClick={closeModal}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={isSubmitting || reason.trim().length < MIN_REASON_LENGTH}
              >
                {isSubmitting ? "Submitting…" : "Confirm"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
