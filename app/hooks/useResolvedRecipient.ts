"use client";

import { useEffect, useRef, useState } from "react";
import { isValidStellarPublicKey } from "../lib/stellar-address";
import {
  FederationError,
  isFederationAddress,
  resolveFederationAddress,
} from "../utils/federation";

export interface ResolvedRecipientMemo {
  type: "text" | "id" | "hash";
  value: string;
}

export type ResolvedRecipientStatus = "idle" | "loading" | "resolved" | "error";

export interface ResolvedRecipientState {
  status: ResolvedRecipientStatus;
  address?: string;
  memo?: ResolvedRecipientMemo;
  error?: string;
}

export interface UseResolvedRecipientOptions {
  /** Debounce delay in milliseconds before resolving a federation address. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;

const INVALID_FEDERATION_MESSAGE =
  "Enter a valid Stellar address (G…) or federation address (user*domain.com)";

/**
 * Resolves a recipient input that may be a Stellar public key (`G…`) or a
 * Stellar federation address (`user*domain.com`).
 *
 * - Valid `G…` addresses short-circuit immediately with no network call.
 * - Federation addresses are debounced and resolved via `resolveFederationAddress`
 *   with stale-response protection.
 * - Malformed federation inputs (containing `*` but failing format validation)
 *   report an inline error immediately without making a network request.
 */
export function useResolvedRecipient(
  value: string,
  options: UseResolvedRecipientOptions = {},
): ResolvedRecipientState {
  const { debounceMs = DEFAULT_DEBOUNCE_MS } = options;
  const trimmed = value.trim();

  const [asyncState, setAsyncState] = useState<{
    query: string;
    state: ResolvedRecipientState;
  } | null>(null);

  const requestIdRef = useRef(0);

  const isPlainValidKey = isValidStellarPublicKey(trimmed);
  const isFed = !isPlainValidKey && isFederationAddress(trimmed);
  const isMalformedFed = !isPlainValidKey && !isFed && trimmed.includes("*");

  useEffect(() => {
    if (!isFed) {
      // Invalidate any in-flight request when the input is no longer a federation address.
      requestIdRef.current += 1;
      return;
    }

    const requestId = ++requestIdRef.current;
    let cancelled = false;

    const timer = setTimeout(() => {
      resolveFederationAddress(trimmed)
        .then((record) => {
          if (cancelled || requestId !== requestIdRef.current) return;
          const memo: ResolvedRecipientMemo | undefined =
            record.memo_type && record.memo
              ? { type: record.memo_type, value: record.memo }
              : undefined;
          setAsyncState({
            query: trimmed,
            state: {
              status: "resolved",
              address: record.account_id,
              ...(memo ? { memo } : {}),
            },
          });
        })
        .catch((err: unknown) => {
          if (cancelled || requestId !== requestIdRef.current) return;
          const message =
            err instanceof FederationError
              ? err.message
              : err instanceof Error
                ? err.message
                : "Failed to resolve federation address";
          setAsyncState({
            query: trimmed,
            state: {
              status: "error",
              error: message,
            },
          });
        });
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, isFed, debounceMs]);

  if (!trimmed) {
    return { status: "idle" };
  }

  if (isPlainValidKey) {
    return { status: "resolved", address: trimmed };
  }

  if (isMalformedFed) {
    return { status: "error", error: INVALID_FEDERATION_MESSAGE };
  }

  if (isFed) {
    if (asyncState && asyncState.query === trimmed) {
      return asyncState.state;
    }
    return { status: "loading" };
  }

  return { status: "idle" };
}
