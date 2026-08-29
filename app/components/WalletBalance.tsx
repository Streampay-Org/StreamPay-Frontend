"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type WalletBalanceProps = {
  /** Resolver for the current balance, e.g. an on-chain query. */
  fetchBalance: (signal?: AbortSignal) => Promise<string>;
  /** Asset code shown next to the amount. */
  assetCode?: string;
  /** Poll interval in milliseconds (defaults to 15s). */
  pollIntervalMs?: number;
};

type Status = "loading" | "idle" | "error";

/**
 * Displays a wallet balance that refreshes on an interval, with a live
 * "refreshing" indicator and a manual refresh control. Stale refreshes are
 * aborted and ignored so late network responses cannot overwrite newer data.
 */
export function WalletBalance({
  fetchBalance,
  assetCode = "XLM",
  pollIntervalMs = 15_000,
}: WalletBalanceProps) {
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const mounted = useRef(true);
  const activeRefreshId = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const refreshId = activeRefreshId.current + 1;
    activeRefreshId.current = refreshId;

    setStatus("loading");
    try {
      const next = await fetchBalance(controller.signal);
      if (
        !mounted.current ||
        controller.signal.aborted ||
        refreshId !== activeRefreshId.current
      ) {
        return;
      }
      setBalance(next);
      setStatus("idle");
    } catch {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        refreshId !== activeRefreshId.current
      ) {
        return;
      }
      setStatus("error");
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
      }
    }
  }, [fetchBalance]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      mounted.current = false;
      activeRefreshId.current += 1;
      activeController.current?.abort();
      activeController.current = null;
      clearInterval(id);
    };
  }, [refresh, pollIntervalMs]);

  return (
    <div className="wallet-balance" aria-live="polite">
      <span className="wallet-balance__amount">
        {balance === null ? "—" : `${balance} ${assetCode}`}
      </span>
      {status === "loading" && (
        <span
          className="wallet-balance__indicator"
          role="status"
          aria-label="Refreshing balance"
        >
          ⟳
        </span>
      )}
      {status === "error" && (
        <span className="wallet-balance__error" role="alert">
          Balance unavailable
        </span>
      )}
      <button
        type="button"
        className="wallet-balance__refresh"
        onClick={() => void refresh()}
        aria-label="Refresh balance now"
      >
        Refresh
      </button>
    </div>
  );
}
