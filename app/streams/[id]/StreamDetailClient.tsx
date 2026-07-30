"use client";

import { useState } from "react";
import Link from "next/link";
import type { Stream, StreamStatus } from "../../types/openapi";
import { StatusBadge } from "../../components/StatusBadge";
import { NetworkBadge } from "../../components/NetworkBadge";
import { PaymentTimeline } from "../../components/PaymentTimeline";
import { ErrorToast } from "../../components/ErrorToast";
import { ConfirmCancel } from "../../components/ConfirmCancel";
import { CancelStreamModal } from "../../components/CancelStreamModal";
import { Timestamp } from "../../components/Timestamp";
import { CopyAddress } from "../../components/CopyAddress";
import { fetchWithIdempotency } from "../../../lib/apiClient";
import { isStreamPayError, normalizeError } from "../../lib/errors";
import type { StreamPayError } from "../../lib/errors";
import { exportStreamVestingAsIcs } from "../../utils/ics";
import type { CancelInput } from "../../lib/cancel-stream";

type StreamDetailClientProps = {
  stream: Stream;
  network?: "testnet" | "mainnet";
};

const ACTION_MAP: Record<string, string> = {
  draft: "Start",
  active: "Pause",
  paused: "Resume",
  ended: "Withdraw",
  withdrawn: "Settled",
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
}: StreamDetailClientProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDestructiveOpen, setIsDestructiveOpen] = useState(false);
  const [error, setError] = useState<StreamPayError | null>(null);

  const actionSummary = STREAM_ACTION_SUMMARY[stream.id] ?? {
    amountLabel: stream.rate,
    destructiveAction: undefined,
    requiresTypedAmount: false,
  };

  const isIncidentMode =
    process.env.NEXT_PUBLIC_DISABLE_ONCHAIN_OPERATIONS === "true";
  const nextAction = ACTION_MAP[stream.status] || "Action";

  const handleDismissError = () => {
    setError(null);
  };

  const handleRetry = async () => {
    if (!error?.retry.retryable) return;
    handleDismissError();
    await handleAction();
  };

  const handleExportIcs = () => {
    try {
      exportStreamVestingAsIcs(
        stream.id,
        stream.rate,
        stream.createdAt,
        stream.status,
        stream.token,
        stream.label,
      );
    } catch (err) {
      console.error("Failed to export ICS:", err);
      alert(
        "Failed to export vesting calendar. Please check the stream rate format.",
      );
    }
  };

  const handleAction = async () => {
    if (isIncidentMode) {
      alert("On-chain operations are temporarily paused during incident mode.");
      return;
    }

    if (stream.status === "withdrawn") {
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const actionRoute = nextAction.toLowerCase();

      await fetchWithIdempotency(`/api/streams/${stream.id}/${actionRoute}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: actionRoute,
        }),
      });

      alert(`${nextAction} successful for stream ${stream.id}!`);
    } catch (err: unknown) {
      const normalizedError = isStreamPayError(err) ? err : normalizeError(err);

      if (process.env.NODE_ENV === "development") {
        console.error("Stream action failed:", err);
      }

      setError(normalizedError);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDestructiveAction = async () => {
    const actionRoute = actionSummary.destructiveAction;
    if (!actionRoute || isIncidentMode) return;

    setIsProcessing(true);
    setError(null);

    try {
      await fetchWithIdempotency(`/api/streams/${stream.id}/${actionRoute}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: actionRoute,
          amount: actionSummary.amountLabel,
        }),
      });

      alert(
        `${actionRoute === "cancel" ? "Cancel" : "Withdraw"} successful for stream ${stream.id}!`,
      );
    } catch (err: unknown) {
      const normalizedError = isStreamPayError(err) ? err : normalizeError(err);

      setError(normalizedError);
    } finally {
      setIsProcessing(false);
    }
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
      <header
        className="page-hero sticky top-0 z-20 backdrop-blur-md bg-white/80 dark:bg-zinc-900/80 border-b border-zinc-200/80 dark:border-zinc-800/80 transition-all duration-200 py-4 px-2 -mx-2 rounded-b-xl shadow-sm"
        role="region"
        aria-label="Stream detail summary header"
      >
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="page-hero__eyebrow mb-0">Stream Detail</p>
            <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
              ID: {stream.id}
            </span>
          </div>

          <div className="detail-header-row flex-wrap sm:flex-nowrap items-center justify-between gap-3">
            <h1 className="page-hero__title detail-title text-xl sm:text-2xl font-bold">
              {stream.label || "Payment Stream"}
            </h1>
            <div className="detail-badges-wrap flex items-center gap-2">
              <StatusBadge
                status={
                  (stream.status === "withdrawn"
                    ? "ended"
                    : stream.status) as any
                }
              />
              <NetworkBadge showLabel={true} />
            </div>
          </div>

          {/* Quick Summary Strip inside Sticky Header */}
          <div className="mt-3 pt-2 border-t border-zinc-100 dark:border-zinc-800/60 flex flex-wrap items-center justify-between text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 gap-2">
            <div>
              <span className="text-zinc-400 dark:text-zinc-500">Rate: </span>
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
                {stream.rate}
              </strong>
            </div>
            {stream.schedule && (
              <div>
                <span className="text-zinc-400 dark:text-zinc-500">
                  Schedule:{" "}
                </span>
                <span>{stream.schedule}</span>
              </div>
            )}
          </div>
        </div>
      </header>

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
                  <code className="receipt-mono">{stream.id}</code>
                </dd>
              </div>
              {stream.email && (
                <div>
                  <dt>Recipient Email</dt>
                  <dd>{stream.email}</dd>
                </div>
              )}
              <div>
                <dt>Recipient Address</dt>
                <dd>
                  <CopyAddress value={stream.recipient} />
                </dd>
              </div>
              <div>
                <dt>Payment Rate</dt>
                <dd className="detail-rate-highlight">{stream.rate}</dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>{stream.schedule}</dd>
              </div>
              <div>
                <dt>Stream Created</dt>
                <dd>
                  <Timestamp iso={stream.createdAt} />
                </dd>
              </div>
              <div>
                <dt>Last Updated</dt>
                <dd>
                  <Timestamp iso={stream.updatedAt} />
                </dd>
              </div>
              {stream.memo && (
                <div>
                  <dt>Memo</dt>
                  <dd>{stream.memo}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Settlement Details (if applicable) */}
          {(stream.settlementTxHash || stream.withdrawal) && (
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
                {stream.settlementTxHash && (
                  <div>
                    <dt>Settlement TX</dt>
                    <dd>
                      <CopyAddress
                        value={stream.settlementTxHash}
                        truncateChars={8}
                      />
                    </dd>
                  </div>
                )}
                {stream.withdrawal && (
                  <>
                    <div>
                      <dt>Withdrawal State</dt>
                      <dd style={{ textTransform: "capitalize" }}>
                        {stream.withdrawal.state}
                      </dd>
                    </div>
                    <div>
                      <dt>Requested At</dt>
                      <dd>
                        <Timestamp iso={stream.withdrawal.requestedAt} />
                      </dd>
                    </div>
                    {stream.withdrawal.confirmedTxHash && (
                      <div>
                        <dt>Confirmed TX</dt>
                        <dd>
                          <CopyAddress
                            value={stream.withdrawal.confirmedTxHash}
                            truncateChars={8}
                          />
                        </dd>
                      </div>
                    )}
                    {stream.withdrawal.failureCode && (
                      <div>
                        <dt>Failure Code</dt>
                        <dd>
                          <code className="receipt-mono">
                            {stream.withdrawal.failureCode}
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
            <div className="detail-actions-row">
              <button
                className="button button--primary detail-action-btn"
                type="button"
                onClick={handleAction}
                disabled={
                  isProcessing ||
                  isIncidentMode ||
                  stream.status === "withdrawn"
                }
              >
                {isProcessing ? "Processing..." : nextAction}
              </button>

              <Link
                href={`/streams/${stream.id}/receipt`}
                className="button button--secondary detail-action-btn"
              >
                Print Stream Receipt
              </Link>

              <Link
                href={`/streams/${stream.id}/events`}
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
                  disabled={isProcessing || isIncidentMode}
                >
                  {actionSummary.destructiveAction === "cancel"
                    ? "Cancel Stream"
                    : "Withdraw Funds"}
                </button>
              )}
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
          <PaymentTimeline stream={stream} />
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
          stream={{ status: stream.status }}
          split={{
            totalAmount: BigInt(stream.totalAmount ?? "0"),
            releasedAmount: BigInt(stream.releasedAmount ?? "0"),
            vestedAmount: BigInt(stream.vestedAmount ?? "0"),
            token: stream.token ?? "XLM",
            senderAddress: stream.senderAddress ?? "",
            recipientAddress: stream.recipient,
          }}
          tokenLabel={stream.token ?? "XLM"}
        />
      )}
      {actionSummary.destructiveAction === "withdraw" && (
        <ConfirmCancel
          action={actionSummary.destructiveAction}
          amountLabel={actionSummary.amountLabel}
          isOpen={isDestructiveOpen}
          onClose={() => setIsDestructiveOpen(false)}
          onConfirm={handleDestructiveAction}
          recipientLabel={stream.label || stream.email || stream.recipient}
          requiresTypedAmount={actionSummary.requiresTypedAmount}
        />
      )}
    </main>
  );
}
