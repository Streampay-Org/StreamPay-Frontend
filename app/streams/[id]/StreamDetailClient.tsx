"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Stream, StreamStatus } from "../../types/openapi";
import { StatusBadge } from "../../components/StatusBadge";
import { NetworkBadge } from "../../components/NetworkBadge";
import { PaymentTimeline } from "../../components/PaymentTimeline";
import { ErrorToast } from "../../components/ErrorToast";
import { ConfirmCancel } from "../../components/ConfirmCancel";
import { CancelStreamModal } from "../../components/CancelStreamModal";
import { SwitchNetwork } from "../../components/SwitchNetwork";
import { Timestamp } from "../../components/Timestamp";
import { CopyAddress } from "../../components/CopyAddress";
import { fetchWithIdempotency } from "../../../lib/apiClient";
import { isStreamPayError, normalizeError } from "../../lib/errors";
import type { StreamPayError } from "../../lib/errors";
import { exportStreamVestingAsIcs } from "../../utils/ics";

type StreamDetailClientProps = {
  stream: Stream;
  network?: "testnet" | "mainnet";
  walletNetwork?: "testnet" | "mainnet";
  onSwitchNetwork?: (network: string) => Promise<void> | void;
};

const ACTION_MAP: Record<string, string> = {
  draft: "Start",
  active: "Pause",
  paused: "Resume",
  ended: "Withdraw",
  withdrawn: "Settled",
};

type PendingAction = { action: string; key: string };
type StatusTone = "success" | "error";

const ACTION_LABELS: Record<string, string> = {
  start: "Start",
  pause: "Pause",
  resume: "Resume",
  withdraw: "Withdraw",
  settle: "Settlement",
  settled: "Settlement",
  cancel: "Cancel",
  "withdraw-destructive": "Withdraw",
};

const STREAM_STATUS_LABELS: Record<StreamStatus, string> = {
  active: "Active",
  draft: "Draft",
  ended: "Ended",
  paused: "Paused",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
};

const STREAM_ACTION_SUMMARY: Record<
  string,
  {
    amountLabel: string;
    destructiveAction?: "cancel" | "withdraw";
    requiresTypedAmount?: boolean;
  }
> = {
  "stream-ada": {
    amountLabel: "120 XLM",
    destructiveAction: "cancel",
    requiresTypedAmount: true,
  },
  "stream-kemi": {
    amountLabel: "32 XLM",
    destructiveAction: "cancel",
    requiresTypedAmount: false,
  },
  "stream-yusuf": {
    amountLabel: "18 XLM",
    destructiveAction: "withdraw",
    requiresTypedAmount: false,
  },
};

export function StreamDetailClient({
  stream,
  network = "testnet",
  walletNetwork,
  onSwitchNetwork,
}: StreamDetailClientProps) {
  const [current, setCurrent] = useState<Stream>(stream);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDestructiveOpen, setIsDestructiveOpen] = useState(false);
  const [error, setError] = useState<StreamPayError | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<StatusTone>("success");
  const inFlightRef = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const actionSummary = STREAM_ACTION_SUMMARY[current.id] ?? {
    amountLabel: current.rate,
    destructiveAction: undefined,
    requiresTypedAmount: false,
  };

  const isIncidentMode =
    process.env.NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS === "true";
  const nextAction = ACTION_MAP[current.status] || "Action";
  const networkMismatch =
    walletNetwork !== undefined && walletNetwork.toLowerCase() !== network.toLowerCase();
  const mutationsDisabled = isIncidentMode || networkMismatch;
  const lifecycleDisabled =
    mutationsDisabled ||
    current.status === "withdrawn" ||
    current.status === "cancelled";
  const destructiveDisabled =
    isProcessing ||
    mutationsDisabled ||
    (actionSummary.destructiveAction === "cancel" &&
      (current.status === "draft" ||
        current.status === "cancelled" ||
        current.status === "ended" ||
        current.status === "withdrawn"));

  // The status region must exist before its text changes so assistive tech
  // announces the update, then receive focus so sighted keyboard users land on
  // the outcome of the action they triggered.
  useEffect(() => {
    if (statusMessage) {
      statusRef.current?.focus();
    }
  }, [statusMessage]);

  const handleDismissError = () => {
    setError(null);
  };

  const showStatus = (message: string, tone: StatusTone = "success") => {
    setStatusTone(tone);
    setStatusMessage(message);
  };

  const buildRequest = (action: string) => {
    const isDestructive =
      action === "cancel" || action === "withdraw-destructive";
    const route = action === "withdraw-destructive" ? "withdraw" : action;

    return {
      route,
      body: isDestructive
        ? { action: route, amount: actionSummary.amountLabel }
        : { action: route },
    };
  };

  const runAction = async (pending: PendingAction) => {
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setIsProcessing(true);
    setError(null);

    const { route, body } = buildRequest(pending.action);

    try {
      const response = await fetchWithIdempotency<{ data?: Stream } | null>(
        `/api/streams/${current.id}/${route}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": pending.key,
          },
          body: JSON.stringify(body),
        },
      );

      const updated =
        response && typeof response === "object" ? response.data : undefined;
      const nextStream = updated ? { ...current, ...updated } : current;

      if (updated) {
        setCurrent(nextStream);
      }

      // Success ends the intent: a later click is a new action and must use a
      // fresh key.
      setPendingAction(null);
      showStatus(
        `${ACTION_LABELS[pending.action] ?? "Action"} successful for stream ${
          nextStream.id
        }. Stream is now ${STREAM_STATUS_LABELS[nextStream.status]}.`,
        "success",
      );
    } catch (err: unknown) {
      const normalizedError = isStreamPayError(err) ? err : normalizeError(err);

      if (process.env.NODE_ENV === "development") {
        console.error("Stream action failed:", err);
      }

      setError(normalizedError);

      // Keep the key only when the user can retry the same intent. A client
      // error means this attempt is final, so the next click starts fresh.
      if (!normalizedError.retry.retryable) {
        setPendingAction(null);
      }
    } finally {
      inFlightRef.current = false;
      setIsProcessing(false);
    }
  };

  const beginAction = async (action: string) => {
    if (inFlightRef.current) return;

    // Reuse the key only for the same intent (for example the toast's Retry
    // button); different actions always get their own key.
    const pending =
      pendingAction?.action === action
        ? pendingAction
        : { action, key: crypto.randomUUID() };

    setPendingAction(pending);
    await runAction(pending);
  };

  const handleRetry = async () => {
    if (!error?.retry.retryable || !pendingAction) return;
    handleDismissError();
    await runAction(pendingAction);
  };

  const handleExportIcs = () => {
    try {
      exportStreamVestingAsIcs(
        current.id,
        current.rate,
        current.createdAt,
        current.status,
        current.token,
        current.label,
      );
    } catch (err) {
      console.error("Failed to export ICS:", err);
      showStatus(
        "Failed to export vesting calendar. Please check the stream rate format.",
        "error",
      );
    }
  };

  const handleAction = async () => {
    if (isProcessing || inFlightRef.current) return;

    if (isIncidentMode) {
      showStatus(
        "On-chain operations are temporarily paused during incident mode.",
        "error",
      );
      return;
    }

    if (networkMismatch) {
      showStatus(`Switch wallet to ${network} before continuing.`, "error");
      return;
    }

    if (current.status === "withdrawn") {
      return;
    }

    await beginAction(nextAction.toLowerCase());
  };

  const handleDestructiveAction = async () => {
    const destructiveAction = actionSummary.destructiveAction;
    if (!destructiveAction || mutationsDisabled) return;

    await beginAction(
      destructiveAction === "withdraw"
        ? "withdraw-destructive"
        : destructiveAction,
    );
  };

  return (
    <main className="page-shell">
      {/* Back to Streams navigation */}
      <nav aria-label="Breadcrumb" className="no-print">
        <Link href="/streams" className="detail-back-link">
          ← Back to Streams
        </Link>
      </nav>

      {/* Sticky Hero Header */}
      <section
        className="page-hero sticky top-0 z-20 backdrop-blur-md bg-white/80 dark:bg-zinc-900/80 border-b border-zinc-200/80 dark:border-zinc-800/80 transition-all duration-200 py-4 px-2 -mx-2 rounded-b-xl shadow-sm"
        aria-label="Stream detail summary header"
      >
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="page-hero__eyebrow mb-0">Stream Detail</p>
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
              ID: {current.id}
            </span>
          </div>

          <div className="detail-header-row flex-wrap sm:flex-nowrap items-center justify-between gap-3">
            <h1 className="page-hero__title detail-title text-xl sm:text-2xl font-bold">
              {current.label || "Payment Stream"}
            </h1>
            <div className="detail-badges-wrap flex items-center gap-2">
              <StatusBadge
                status={
                  (current.status === "withdrawn"
                    ? "ended"
                    : current.status) as any
                }
              />
              <NetworkBadge network={network} showLabel={true} />
            </div>
          </div>

          {/* Quick Summary Strip inside Sticky Header */}
          <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center justify-between text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 gap-2">
            <div>
              <span className="text-zinc-400 dark:text-zinc-500">Rate: </span>
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
                {current.rate}
              </strong>
            </div>
            {current.schedule && (
              <div>
                <span className="text-zinc-400 dark:text-zinc-500">
                  Schedule:{" "}
                </span>
                <span>{current.schedule}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Main Grid Layout */}
      <div className="detail-grid">
        {/* Left Column: Stream Details & Next-Action Panel */}
        <div className="detail-left-col">
          {/* Summary Card */}
          <section className="detail-card" aria-labelledby="summary-heading">
            <h2 id="summary-heading" className="detail-card__heading">
              Stream Summary
            </h2>
            <div className="receipt-divider" style={{ margin: "0.75rem 0" }} />
            <dl className="detail-kv">
              <div>
                <dt>Stream ID</dt>
                <dd>
                  <code className="receipt-mono">{current.id}</code>
                </dd>
              </div>
              {current.email && (
                <div>
                  <dt>Recipient Email</dt>
                  <dd>{current.email}</dd>
                </div>
              )}
              <div>
                <dt>Recipient Address</dt>
                <dd>
                  <CopyAddress value={current.recipient} />
                </dd>
              </div>
              <div>
                <dt>Payment Rate</dt>
                <dd className="detail-rate-highlight">{current.rate}</dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>{current.schedule}</dd>
              </div>
              <div>
                <dt>Stream Created</dt>
                <dd>
                  <Timestamp iso={current.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Last Updated</dt>
                <dd>
                  <Timestamp iso={current.updatedAt} />
                </dd>
              </div>
              {current.memo && (
                <div>
                  <dt>Memo</dt>
                  <dd>{current.memo}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Settlement Details (if applicable) */}
          {(current.settlementTxHash || current.withdrawal) && (
            <section
              className="detail-card"
              aria-labelledby="settlement-heading"
            >
              <h2 id="settlement-heading" className="detail-card__heading">
                Settlement &amp; Chain Details
              </h2>
              <div
                className="receipt-divider"
                style={{ margin: "0.75rem 0" }}
              />
              <dl className="detail-kv">
                {current.settlementTxHash && (
                  <div>
                    <dt>Settlement TX</dt>
                    <dd>
                      <CopyAddress
                        value={current.settlementTxHash}
                        truncateChars={8}
                      />
                    </dd>
                  </div>
                )}
                {current.withdrawal && (
                  <>
                    <div>
                      <dt>Withdrawal State</dt>
                      <dd style={{ textTransform: "capitalize" }}>
                        {current.withdrawal.state}
                      </dd>
                    </div>
                    <div>
                      <dt>Requested At</dt>
                      <dd>
                        <Timestamp iso={current.withdrawal.requestedAt} />
                      </dd>
                    </div>
                    {current.withdrawal.confirmedTxHash && (
                      <div>
                        <dt>Confirmed TX</dt>
                        <dd>
                          <CopyAddress
                            value={current.withdrawal.confirmedTxHash}
                            truncateChars={8}
                          />
                        </dd>
                      </div>
                    )}
                    {current.withdrawal.failureCode && (
                      <div>
                        <dt>Failure Code</dt>
                        <dd>
                          <code className="receipt-mono">
                            {current.withdrawal.failureCode}
                          </code>
                        </dd>
                      </div>
                    )}
                  </>
                )}
              </dl>
            </section>
          )}

          {/* Next Action Panel */}
          <section
            className="detail-card detail-action-card no-print"
            aria-labelledby="action-heading"
          >
            <h2 id="action-heading" className="detail-card__heading">
              Stream Operations
            </h2>
            <div className="receipt-divider" style={{ margin: "0.75rem 0" }} />
            <p className="detail-action-desc">
              Execute lifecycle actions directly on the Stellar ledger, or
              export / save your certified payment stream receipt.
            </p>
            {networkMismatch && walletNetwork && (
              <SwitchNetwork
                currentNetwork={walletNetwork}
                requiredNetwork={network}
                onSwitch={onSwitchNetwork ?? (() => undefined)}
              />
            )}
            <div className="detail-actions-row">
              <button
                className="button button--primary detail-action-btn"
                type="button"
                onClick={handleAction}
                disabled={isProcessing || lifecycleDisabled}
              >
                {isProcessing ? "Processing..." : nextAction}
              </button>

              <Link
                href={`/streams/${current.id}/receipt`}
                className="button button--secondary detail-action-btn"
              >
                Print Stream Receipt
              </Link>

              <Link
                href={`/streams/${current.id}/events`}
                className="button button--secondary detail-action-btn"
              >
                View Contract Events
              </Link>

              <button
                className="button button--secondary detail-action-btn"
                type="button"
                onClick={handleExportIcs}
                aria-label="Export vesting calendar as ICS file"
              >
                Export Calendar (.ics)
              </button>

              {actionSummary.destructiveAction && (
                <button
                  className="button button--danger detail-action-btn"
                  type="button"
                  onClick={() => setIsDestructiveOpen(true)}
                  disabled={destructiveDisabled}
                >
                  {actionSummary.destructiveAction === "cancel"
                    ? "Cancel Stream"
                    : "Withdraw Funds"}
                </button>
              )}
            </div>
            <div
              ref={statusRef}
              role={statusTone === "error" ? "alert" : "status"}
              aria-live={statusTone === "error" ? "assertive" : "polite"}
              aria-atomic="true"
              tabIndex={-1}
              className={`detail-action-status detail-action-status--${statusTone}`}
              data-testid="action-status"
            >
              {statusMessage}
            </div>
            {actionSummary.destructiveAction === "cancel" && (
              <p className="detail-action-note">
                Large cancels require a typed amount confirmation before the
                request is submitted.
              </p>
            )}
            {isIncidentMode && (
              <p className="detail-incident-warning" role="alert">
                ⚠️ On-chain operations are temporarily paused during incident
                mode.
              </p>
            )}
          </section>
        </div>

        {/* Right Column: Payment Timeline */}
        <div className="detail-right-col">
          <PaymentTimeline stream={current} />
        </div>
      </div>

      {error && (
        <ErrorToast
          error={error}
          onDismiss={handleDismissError}
          onRetry={error.retry.retryable ? handleRetry : undefined}
          autoDismiss={!error.retry.retryable}
          autoDismissDelayMs={5000}
        />
      )}

      {actionSummary.destructiveAction === "cancel" && (
        <CancelStreamModal
          isOpen={isDestructiveOpen}
          onClose={() => setIsDestructiveOpen(false)}
          onConfirm={handleDestructiveAction}
          stream={current}
          tokenLabel={current.token ?? "XLM"}
        />
      )}
      {actionSummary.destructiveAction === "withdraw" && (
        <ConfirmCancel
          action={actionSummary.destructiveAction}
          amountLabel={actionSummary.amountLabel}
          isOpen={isDestructiveOpen}
          onClose={() => setIsDestructiveOpen(false)}
          onConfirm={handleDestructiveAction}
          recipientLabel={current.label || current.email || current.recipient}
          requiresTypedAmount={actionSummary.requiresTypedAmount}
        />
      )}
    </main>
  );
}
