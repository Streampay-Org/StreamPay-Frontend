"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalAction, ApprovalStatus, PendingApproval } from "@/app/lib/org-types";
import type { ErrorCategory, ErrorCode, StreamPayError } from "@/app/lib/errors/types";

export const WALLET_ADDRESS_STORAGE_KEY = "streampay_wallet_address";

export type ApprovalTabStatus = "pending" | "approved" | "rejected";

export interface ApprovalItem {
  id: string;
  streamId: string;
  orgId: string;
  action: ApprovalAction;
  initiatedBy: string;
  approvals: string[];
  requiredCount: number;
  /** Normalised bucket for the 3-tab inbox */
  status: ApprovalTabStatus;
  /** Original status from the API (may be "expired") */
  rawStatus: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
}

export interface VoteResult {
  ok: boolean;
  thresholdMet?: boolean;
  approval?: ApprovalItem;
  errorMessage?: string;
  errorCode?: string;
  httpStatus?: number;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
}

/**
 * Normalise an API approval status into one of the three inbox tabs.
 * Expired approvals are grouped under "rejected" so they are never silently hidden.
 */
export function normaliseApprovalStatus(status: string | undefined): ApprovalTabStatus {
  const lower = (status ?? "").toLowerCase();
  if (lower === "approved") return "approved";
  if (lower === "rejected" || lower === "expired") return "rejected";
  return "pending";
}

export function normaliseApproval(raw: PendingApproval): ApprovalItem {
  const rawStatus: ApprovalStatus =
    raw.status === "approved" ||
    raw.status === "rejected" ||
    raw.status === "expired" ||
    raw.status === "pending"
      ? raw.status
      : "pending";

  return {
    id: raw.id,
    streamId: raw.streamId,
    orgId: raw.orgId,
    action: raw.action,
    initiatedBy: raw.initiatedBy,
    approvals: Array.isArray(raw.approvals) ? [...raw.approvals] : [],
    requiredCount: typeof raw.requiredCount === "number" && raw.requiredCount > 0 ? raw.requiredCount : 1,
    status: normaliseApprovalStatus(rawStatus),
    rawStatus,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };
}

/**
 * Map server error codes and HTTP statuses from the /approve endpoint
 * to specific, human-readable messages.
 */
export function mapVoteErrorMessage(
  code: string | undefined,
  status: number,
  serverMessage?: string,
): string {
  const normalizedCode = (code ?? "").toUpperCase();
  const lowerMsg = (serverMessage ?? "").toLowerCase();

  if (normalizedCode === "APPROVAL_NOT_FOUND" || status === 404) {
    return "This approval could not be found—it may have already been removed.";
  }

  if (normalizedCode === "UNAUTHORIZED" || status === 401) {
    return "A connected wallet address is required to cast a vote.";
  }

  if (normalizedCode === "VOTE_FAILED" || status === 403 || status === 409) {
    if (status === 403) {
      if (lowerMsg.includes("not a member")) {
        return "You are not a member of this organization and cannot vote on its approvals.";
      }
      return "Your organization role does not have permission to approve this action.";
    }

    if (status === 409) {
      if (lowerMsg.includes("already")) {
        return "You have already voted on this approval.";
      }
      if (lowerMsg.includes("expired")) {
        return "This approval has expired and can no longer accept votes.";
      }
      return "This approval is no longer pending and cannot accept votes.";
    }
  }

  if (status === 0) {
    return "Network error while submitting your vote. Please check your connection and try again.";
  }

  return serverMessage || "Failed to cast approval vote. Please try again.";
}

function buildLoadError(
  status: number,
  code: string,
  message: string,
  requestId?: string,
  isNetworkError = false,
): StreamPayError {
  let errorCode: ErrorCode = "UNKNOWN_ERROR";
  let category: ErrorCategory = "unknown";

  if (isNetworkError) {
    errorCode = "NETWORK_UNAVAILABLE";
    category = "network";
  } else if (status === 403) {
    errorCode = "FORBIDDEN";
    category = "auth";
  } else if (status === 404) {
    errorCode = "NOT_FOUND";
    category = "client";
  } else if (status >= 500) {
    errorCode = "INTERNAL_ERROR";
    category = "server";
  } else if (status >= 400) {
    errorCode = "BAD_REQUEST";
    category = "client";
  }

  return {
    code: errorCode,
    category,
    title: code || "LOAD_FAILED",
    detail: message,
    message,
    status,
    statusCode: status,
    requestId,
    retry: { retryable: isNetworkError || status >= 500 },
    timestamp: new Date().toISOString(),
  } as StreamPayError;
}

export interface UseApprovalsOptions {
  initialWalletAddress?: string;
}

export function useApprovals(options: UseApprovalsOptions = {}) {
  const [walletAddress, setWalletAddressState] = useState<string>(() => {
    if (options.initialWalletAddress !== undefined) {
      return options.initialWalletAddress;
    }
    if (typeof window !== "undefined") {
      return window.localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY) ?? "";
    }
    return "";
  });

  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<StreamPayError | null>(null);
  const [votingIds, setVotingIds] = useState<Set<string>>(() => new Set());

  // Synchronous ref to guarantee double-clicking sends exactly one request
  const inFlightVotesRef = useRef<Set<string>>(new Set());
  const approvalsRef = useRef<ApprovalItem[]>(approvals);
  approvalsRef.current = approvals;

  const setWalletAddress = useCallback((next: string) => {
    const trimmed = next.trim();
    setWalletAddressState(trimmed);
    if (typeof window !== "undefined") {
      if (trimmed) {
        window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(WALLET_ADDRESS_STORAGE_KEY);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const headers: Record<string, string> = {};
      if (walletAddress) {
        headers["Actor-Wallet-Address"] = walletAddress;
      }

      const res = await fetch("/api/approvals", {
        method: "GET",
        headers,
      });

      if (!res.ok) {
        let payload: ApiErrorPayload | null = null;
        try {
          payload = (await res.json()) as ApiErrorPayload;
        } catch {
          // ignore non-JSON error body
        }
        const code = payload?.error?.code ?? "LOAD_APPROVALS_FAILED";
        const message =
          payload?.error?.message ?? `Failed to load approvals (HTTP ${res.status}).`;
        setError(buildLoadError(res.status, code, message, payload?.error?.request_id));
        return;
      }

      const json = (await res.json()) as { data?: PendingApproval[] };
      const items = Array.isArray(json.data) ? json.data.map(normaliseApproval) : [];
      setApprovals(items);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Network error while loading approvals.";
      setError(buildLoadError(0, "NETWORK_UNAVAILABLE", message, undefined, true));
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const vote = useCallback(
    async (approvalId: string): Promise<VoteResult> => {
      // Prevent duplicate concurrent requests (e.g. rapid double-click)
      if (inFlightVotesRef.current.has(approvalId)) {
        return { ok: false, errorCode: "IN_FLIGHT" };
      }

      const target = approvalsRef.current.find((item) => item.id === approvalId);
      if (!target) {
        return {
          ok: false,
          errorCode: "APPROVAL_NOT_FOUND",
          httpStatus: 404,
          errorMessage: mapVoteErrorMessage("APPROVAL_NOT_FOUND", 404),
        };
      }

      if (!walletAddress) {
        return {
          ok: false,
          errorCode: "UNAUTHORIZED",
          httpStatus: 401,
          errorMessage: mapVoteErrorMessage("UNAUTHORIZED", 401),
        };
      }

      inFlightVotesRef.current.add(approvalId);
      setVotingIds((prev) => {
        const next = new Set(prev);
        next.add(approvalId);
        return next;
      });

      // Snapshot for rollback on failure
      const previousSnapshot = target;

      // Optimistic update: increment votes
      setApprovals((prev) =>
        prev.map((item) => {
          if (item.id !== approvalId) return item;
          if (item.approvals.includes(walletAddress)) return item;
          return {
            ...item,
            approvals: [...item.approvals, walletAddress],
          };
        }),
      );

      try {
        const res = await fetch(
          `/api/streams/${encodeURIComponent(target.streamId)}/approvals/${encodeURIComponent(approvalId)}/approve`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Actor-Wallet-Address": walletAddress,
            },
          },
        );

        if (!res.ok) {
          let payload: ApiErrorPayload | null = null;
          try {
            payload = (await res.json()) as ApiErrorPayload;
          } catch {
            // ignore non-JSON body
          }

          const errorCode = payload?.error?.code ?? "VOTE_FAILED";
          const errorMessage = mapVoteErrorMessage(
            errorCode,
            res.status,
            payload?.error?.message,
          );

          // Roll back optimistic update
          setApprovals((prev) =>
            prev.map((item) => (item.id === approvalId ? previousSnapshot : item)),
          );

          return {
            ok: false,
            errorCode,
            httpStatus: res.status,
            errorMessage,
          };
        }

        const json = (await res.json()) as {
          data?: PendingApproval;
          meta?: { thresholdMet?: boolean };
        };

        const thresholdMet = Boolean(json.meta?.thresholdMet);
        const updatedItem: ApprovalItem = json.data
          ? normaliseApproval({
              ...json.data,
              status: thresholdMet ? "approved" : json.data.status,
            })
          : {
              ...previousSnapshot,
              approvals: previousSnapshot.approvals.includes(walletAddress)
                ? previousSnapshot.approvals
                : [...previousSnapshot.approvals, walletAddress],
              status: thresholdMet ? "approved" : previousSnapshot.status,
              rawStatus: thresholdMet ? "approved" : previousSnapshot.rawStatus,
            };

        setApprovals((prev) =>
          prev.map((item) => (item.id === approvalId ? updatedItem : item)),
        );

        return {
          ok: true,
          thresholdMet,
          approval: updatedItem,
        };
      } catch {
        // Roll back optimistic update on network error
        setApprovals((prev) =>
          prev.map((item) => (item.id === approvalId ? previousSnapshot : item)),
        );

        return {
          ok: false,
          errorCode: "NETWORK_ERROR",
          httpStatus: 0,
          errorMessage: mapVoteErrorMessage("NETWORK_ERROR", 0),
        };
      } finally {
        inFlightVotesRef.current.delete(approvalId);
        setVotingIds((prev) => {
          const next = new Set(prev);
          next.delete(approvalId);
          return next;
        });
      }
    },
    [walletAddress],
  );

  const grouped = useMemo(() => {
    const pending: ApprovalItem[] = [];
    const approved: ApprovalItem[] = [];
    const rejected: ApprovalItem[] = [];

    for (const item of approvals) {
      if (item.status === "pending") pending.push(item);
      else if (item.status === "approved") approved.push(item);
      else rejected.push(item);
    }

    return { pending, approved, rejected };
  }, [approvals]);

  return {
    approvals,
    pending: grouped.pending,
    approved: grouped.approved,
    rejected: grouped.rejected,
    loading,
    error,
    votingIds,
    walletAddress,
    setWalletAddress,
    refresh,
    vote,
  };
}
