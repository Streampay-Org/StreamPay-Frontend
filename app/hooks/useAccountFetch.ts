'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  AccountFetchCoordinator,
  AccountSwitchedError,
  defaultAccountFetchCoordinator,
} from '@/lib/accountFetchCoordinator';

export interface UseAccountFetchOptions<T> {
  /** Custom coordinator instance (defaults to global singleton) */
  coordinator?: AccountFetchCoordinator;
  /** Whether to automatically fetch when accountId changes or on mount (default: true) */
  enabled?: boolean;
  /** Deduplication key */
  dedupKey?: string;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Number of retries on transient errors (default: 0) */
  retries?: number;
  /** Initial data fallback */
  initialData?: T | null;
  /** Success callback */
  onSuccess?: (data: T, accountId: string) => void;
  /** Error callback */
  onError?: (error: Error, accountId: string) => void;
}

export interface UseAccountFetchResult<T> {
  data: T | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  accountId: string | null;
  isStale: boolean;
  refetch: () => Promise<T | null>;
  abort: () => void;
}

/**
 * Custom React hook for race-condition-safe data fetching across Stellar account switches.
 *
 * Prevents stale responses from previous accounts from overwriting newly switched account state.
 */
export function useAccountFetch<T>(
  accountId: string | null | undefined,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: UseAccountFetchOptions<T> = {}
): UseAccountFetchResult<T> {
  const {
    coordinator = defaultAccountFetchCoordinator,
    enabled = true,
    dedupKey,
    timeoutMs = 30000,
    retries = 0,
    initialData = null,
    onSuccess,
    onError,
  } = options;

  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(enabled && accountId));
  const [error, setError] = useState<Error | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);

  const activeAccountRef = useRef<string | null>(accountId ?? null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Track latest request identifier per hook instance to prevent intra-account out-of-order responses
  const requestSequenceRef = useRef<number>(0);

  const executeFetch = useCallback(
    async (targetAccount: string): Promise<T | null> => {
      const sequence = ++requestSequenceRef.current;
      setIsLoading(true);
      setError(null);
      setIsStale(false);

      try {
        const result = await coordinator.execute<T>(
          targetAccount,
          (signal) => fetcherRef.current(signal),
          {
            dedupKey,
            timeoutMs,
            retries,
          }
        );

        // Ensure this response is still for the currently active account & latest sequence
        if (activeAccountRef.current === targetAccount && requestSequenceRef.current === sequence) {
          setData(result);
          setIsLoading(false);
          setError(null);
          setIsStale(false);
          onSuccessRef.current?.(result, targetAccount);
          return result;
        }
        return null;
      } catch (err) {
        if (err instanceof AccountSwitchedError || (err instanceof Error && err.name === 'AccountSwitchedError')) {
          // Account switched: do not update state with old account error
          return null;
        }

        if (activeAccountRef.current === targetAccount && requestSequenceRef.current === sequence) {
          const castError = err instanceof Error ? err : new Error(String(err));
          setError(castError);
          setIsLoading(false);
          onErrorRef.current?.(castError, targetAccount);
        }
        return null;
      }
    },
    [coordinator, dedupKey, timeoutMs, retries]
  );

  useEffect(() => {
    const currentAccount = accountId ?? null;
    activeAccountRef.current = currentAccount;

    // Notify coordinator of account change
    coordinator.switchAccount(currentAccount);

    if (!currentAccount || !enabled) {
      setData(null);
      setIsLoading(false);
      setError(null);
      setIsStale(false);
      return;
    }

    // Reset data or mark stale on account change
    setData(null);
    setError(null);
    executeFetch(currentAccount);

    return () => {
      // Invalidate on account change or unmount
      requestSequenceRef.current++;
    };
  }, [accountId, enabled, coordinator, executeFetch]);

  const refetch = useCallback(async (): Promise<T | null> => {
    if (!activeAccountRef.current) {
      return null;
    }
    return executeFetch(activeAccountRef.current);
  }, [executeFetch]);

  const abort = useCallback(() => {
    if (activeAccountRef.current) {
      coordinator.switchAccount(null);
    }
    setIsLoading(false);
  }, [coordinator]);

  return {
    data,
    isLoading,
    isError: error !== null,
    error,
    accountId: accountId ?? null,
    isStale,
    refetch,
    abort,
  };
}
