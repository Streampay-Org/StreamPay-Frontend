"use client";

import React, { useCallback, useId, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState } from "@/app/components/EmptyState";
import { ErrorBanner } from "@/app/components/ErrorBanner";
import { LiveRegion } from "@/app/components/LiveRegion";
import { Skeleton } from "@/app/components/Skeleton";
import { Tabs, type TabDefinition } from "@/app/components/Tabs";
import { Timestamp } from "@/app/components/Timestamp";
import { useToast } from "@/app/components/ToastProvider";
import { type ApprovalItem, useApprovals } from "./useApprovals";

function truncateWallet(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatActionLabel(action: ApprovalItem["action"]): string {
  return action === "settle" ? "Settle" : "Stop";
}

interface ApprovalTableProps {
  items: ApprovalItem[];
  showVoteAction: boolean;
  walletAddress: string;
  votingIds: ReadonlySet<string>;
  onVote: (item: ApprovalItem) => void;
  emptyEyebrow: string;
  emptyTitle: string;
  emptyDescription: string;
  onRefresh: () => void;
}

function ApprovalList({
  items,
  showVoteAction,
  walletAddress,
  votingIds,
  onVote,
  emptyEyebrow,
  emptyTitle,
  emptyDescription,
  onRefresh,
}: ApprovalTableProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        eyebrow={emptyEyebrow}
        title={emptyTitle}
        description={emptyDescription}
        actionLabel="Refresh approvals"
        onAction={onRefresh}
        variant="generic"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
            <th scope="col" className="py-3 pr-4 font-semibold">
              Stream
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              Action
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              Initiator
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              Votes
            </th>
            <th scope="col" className="py-3 pr-4 font-semibold">
              Created
            </th>
            {showVoteAction ? (
              <th scope="col" className="py-3 text-right font-semibold">
                Vote
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((item) => {
            const isVoting = votingIds.has(item.id);
            const hasVoted = Boolean(walletAddress) && item.approvals.includes(walletAddress);
            const voteDisabled = isVoting || hasVoted || !walletAddress;

            let buttonLabel = "Approve";
            if (isVoting) {
              buttonLabel = "Voting…";
            } else if (hasVoted) {
              buttonLabel = "Voted";
            }

            return (
              <tr
                key={item.id}
                data-testid={`approval-row-${item.id}`}
                data-voting={isVoting ? "true" : "false"}
              >
                <td className="py-3 pr-4 font-medium">
                  <Link
                    href={`/streams/${encodeURIComponent(item.streamId)}`}
                    className="underline hover:no-underline"
                  >
                    {item.streamId}
                  </Link>
                </td>
                <td className="py-3 pr-4">
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                    {formatActionLabel(item.action)}
                  </span>
                  {item.rawStatus === "expired" ? (
                    <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      Expired
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-4 font-mono text-xs" title={item.initiatedBy}>
                  {truncateWallet(item.initiatedBy)}
                </td>
                <td className="py-3 pr-4" data-testid={`approval-votes-${item.id}`}>
                  {item.approvals.length} of {item.requiredCount}
                </td>
                <td className="py-3 pr-4">
                  <Timestamp iso={item.createdAt} />
                </td>
                {showVoteAction ? (
                  <td className="py-3 text-right">
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={voteDisabled}
                      aria-busy={isVoting}
                      aria-label={`Approve ${item.action} for stream ${item.streamId}`}
                      onClick={() => onVote(item)}
                    >
                      {buttonLabel}
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ApprovalsPage() {
  const {
    pending,
    approved,
    rejected,
    loading,
    error,
    votingIds,
    walletAddress,
    setWalletAddress,
    refresh,
    vote,
  } = useApprovals();

  const toast = useToast();
  const [liveMessage, setLiveMessage] = useState("");
  const walletInputId = useId();

  const handleVote = useCallback(
    async (item: ApprovalItem) => {
      const result = await vote(item.id);

      if (!result.ok) {
        if (result.errorCode === "IN_FLIGHT") return;
        const message =
          result.errorMessage || "Failed to cast approval vote. Please try again.";
        toast.error(message, { title: "Vote failed" });
        setLiveMessage(`Vote failed for ${item.streamId}: ${message}`);
        return;
      }

      if (result.thresholdMet) {
        const message = `Threshold met for ${item.action} on stream ${item.streamId}.`;
        toast.success(message, { title: "Threshold met" });
        setLiveMessage(message);
      } else {
        const message = `Vote recorded for ${item.action} on stream ${item.streamId}.`;
        toast.success(message, { title: "Vote recorded" });
        setLiveMessage(message);
      }
    },
    [toast, vote],
  );

  const tabs: TabDefinition[] = useMemo(
    () => [
      {
        id: "pending",
        label: `Pending (${pending.length})`,
        content: (
          <ApprovalList
            items={pending}
            showVoteAction
            walletAddress={walletAddress}
            votingIds={votingIds}
            onVote={handleVote}
            emptyEyebrow="All caught up"
            emptyTitle="No pending approvals"
            emptyDescription="Multi-sig approvals for org-owned stream settle or stop actions will appear here."
            onRefresh={refresh}
          />
        ),
      },
      {
        id: "approved",
        label: `Approved (${approved.length})`,
        content: (
          <ApprovalList
            items={approved}
            showVoteAction={false}
            walletAddress={walletAddress}
            votingIds={votingIds}
            onVote={handleVote}
            emptyEyebrow="History"
            emptyTitle="No approved requests yet"
            emptyDescription="Approvals that meet the organization threshold will appear here."
            onRefresh={refresh}
          />
        ),
      },
      {
        id: "rejected",
        label: `Rejected (${rejected.length})`,
        content: (
          <ApprovalList
            items={rejected}
            showVoteAction={false}
            walletAddress={walletAddress}
            votingIds={votingIds}
            onVote={handleVote}
            emptyEyebrow="History"
            emptyTitle="No rejected or expired approvals"
            emptyDescription="Rejected or expired multi-sig approval requests will appear here."
            onRefresh={refresh}
          />
        ),
      },
    ],
    [pending, approved, rejected, walletAddress, votingIds, handleVote, refresh],
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Approvals</h1>
          <p className="mt-1 text-sm text-gray-600">
            Review and vote on multi-sig approvals for org-owned streams.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor={walletInputId}
              className="block text-xs font-medium text-gray-700"
            >
              Actor wallet address
              <input
                id={walletInputId}
                type="text"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder="G..."
                className="mt-1 block w-64 rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs"
              />
            </label>
          </div>
          <button
            type="button"
            className="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-6">
          <ErrorBanner error={error} onRetry={() => void refresh()} />
        </div>
      ) : null}

      {loading ? (
        <section aria-busy="true" aria-label="Loading approvals">
          <span className="sr-only">Loading approvals…</span>
          <div className="space-y-3">
            <Skeleton variant="title" height={32} />
            <Skeleton variant="text" height={48} />
            <Skeleton variant="text" height={48} />
            <Skeleton variant="text" height={48} />
          </div>
        </section>
      ) : (
        <Tabs tabs={tabs} defaultTabId="pending" />
      )}

      <LiveRegion
        message={liveMessage}
        allowDuplicates
        data-testid="approvals-live-region"
      />
    </main>
  );
}
