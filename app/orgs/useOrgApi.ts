"use client";

import { useCallback, useEffect, useState } from "react";
import type { OrgMember, OrgRecord, OrgRole, StreamPolicy } from "@/app/lib/org-types";
import type { ErrorCategory, ErrorCode, StreamPayError } from "@/app/lib/errors/types";

export const WALLET_ADDRESS_STORAGE_KEY = "streampay_wallet_address";

export interface OrgSummary {
  id: string;
  name: string;
  memberCount: number;
  policy: StreamPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface OrgDetail extends OrgRecord {
  ownedStreams: string[];
  tokenAllowlist: string[];
}

export interface TokenAllowlistData {
  orgId: string;
  tokens: string[];
  enabled: boolean;
  added?: boolean;
  removed?: boolean;
}

export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
  };
}

export class OrgApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly isNetworkError: boolean;

  constructor(options: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    isNetworkError?: boolean;
  }) {
    super(options.message);
    this.name = "OrgApiError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.isNetworkError = Boolean(options.isNetworkError);
  }
}

export function toStreamPayError(err: unknown): StreamPayError {
  if (err instanceof OrgApiError) {
    let code: ErrorCode = "UNKNOWN_ERROR";
    let category: ErrorCategory = "unknown";

    if (err.isNetworkError) {
      code = "NETWORK_UNAVAILABLE";
      category = "network";
    } else if (err.status === 403 || err.code === "FORBIDDEN" || err.code === "ACTOR_REQUIRED") {
      code = "FORBIDDEN";
      category = "auth";
    } else if (err.status === 404 || err.code === "ORG_NOT_FOUND") {
      code = "NOT_FOUND";
      category = "client";
    } else if (err.status === 422 || err.code === "VALIDATION_ERROR" || err.code === "INVALID_TOKEN") {
      code = "VALIDATION_ERROR";
      category = "validation";
    } else if (err.status >= 500) {
      code = "INTERNAL_ERROR";
      category = "server";
    } else if (err.status === 400) {
      code = "BAD_REQUEST";
      category = "client";
    }

    const retryable = err.isNetworkError || err.status >= 500;

    return {
      code,
      category,
      title: err.code,
      detail: err.message,
      message: err.message,
      status: err.status,
      statusCode: err.status,
      requestId: err.requestId,
      retry: { retryable },
      timestamp: new Date().toISOString(),
    } as StreamPayError;
  }

  const fallbackMessage =
    err instanceof Error ? err.message : "An unexpected error occurred.";

  return {
    code: "NETWORK_UNAVAILABLE",
    category: "network",
    title: "Network Error",
    detail: fallbackMessage,
    message: fallbackMessage,
    status: 0,
    statusCode: 0,
    retry: { retryable: true },
    timestamp: new Date().toISOString(),
  } as StreamPayError;
}

async function parseResponse<T>(response: Response): Promise<{ data: T; status: number }> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const envelope = (payload ?? {}) as ApiErrorEnvelope;
    const code = envelope.error?.code ?? `HTTP_${response.status}`;
    const message =
      envelope.error?.message ??
      (response.statusText || `Request failed with status ${response.status}.`);
    throw new OrgApiError({
      code,
      message,
      status: response.status,
      requestId: envelope.error?.request_id,
    });
  }

  const data = (payload as { data: T } | null)?.data as T;
  return { data, status: response.status };
}

async function requestJson<T>(
  input: string,
  init?: RequestInit,
): Promise<{ data: T; status: number }> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    throw new OrgApiError({
      code: "NETWORK_UNAVAILABLE",
      message:
        err instanceof Error && err.message
          ? err.message
          : "Unable to reach the server. Please check your connection and try again.",
      status: 0,
      isNetworkError: true,
    });
  }
  return parseResponse<T>(response);
}

export async function listOrgs(): Promise<OrgSummary[]> {
  const { data } = await requestJson<OrgSummary[]>("/api/orgs", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  return Array.isArray(data) ? data : [];
}

export async function createOrg(input: {
  name: string;
  ownerWalletAddress: string;
}): Promise<OrgRecord> {
  const { data } = await requestJson<OrgRecord>("/api/orgs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  return data;
}

export async function getOrg(orgId: string): Promise<OrgDetail> {
  const { data } = await requestJson<OrgDetail>(`/api/orgs/${encodeURIComponent(orgId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  return data;
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  const { data } = await requestJson<OrgMember[]>(
    `/api/orgs/${encodeURIComponent(orgId)}/members`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  return Array.isArray(data) ? data : [];
}

export async function addOrgMember(
  orgId: string,
  input: { walletAddress: string; role: OrgRole },
  actorWalletAddress: string,
): Promise<{ member: OrgMember; existed: boolean }> {
  const { data, status } = await requestJson<OrgMember>(
    `/api/orgs/${encodeURIComponent(orgId)}/members`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Actor-Wallet-Address": actorWalletAddress,
      },
      body: JSON.stringify(input),
    },
  );
  return { member: data, existed: status === 200 };
}

export async function getTokenAllowlist(orgId: string): Promise<TokenAllowlistData> {
  const { data } = await requestJson<TokenAllowlistData>(
    `/api/orgs/${encodeURIComponent(orgId)}/token-allowlist`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    },
  );
  return data;
}

export async function addOrgAllowedToken(
  orgId: string,
  token: string,
  actorWalletAddress: string,
): Promise<TokenAllowlistData> {
  const { data } = await requestJson<TokenAllowlistData>(
    `/api/orgs/${encodeURIComponent(orgId)}/token-allowlist`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Actor-Wallet-Address": actorWalletAddress,
      },
      body: JSON.stringify({ token }),
    },
  );
  return data;
}

export async function removeOrgAllowedToken(
  orgId: string,
  token: string,
  actorWalletAddress: string,
): Promise<TokenAllowlistData> {
  const { data } = await requestJson<TokenAllowlistData>(
    `/api/orgs/${encodeURIComponent(orgId)}/token-allowlist`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Actor-Wallet-Address": actorWalletAddress,
      },
      body: JSON.stringify({ token }),
    },
  );
  return data;
}

/**
 * Shared hook exposing connected wallet state (persisted in localStorage)
 * alongside the org API helpers.
 */
export function useOrgApi() {
  const [walletAddress, setWalletAddressState] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY);
      if (stored) {
        setWalletAddressState(stored.trim());
      }
    } catch {
      // Ignore storage access errors in restricted environments.
    }
  }, []);

  const setWalletAddress = useCallback((next: string) => {
    const trimmed = next.trim();
    setWalletAddressState(trimmed);
    if (typeof window === "undefined") return;
    try {
      if (trimmed) {
        window.localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(WALLET_ADDRESS_STORAGE_KEY);
      }
    } catch {
      // Ignore storage access errors.
    }
  }, []);

  return {
    walletAddress,
    setWalletAddress,
    listOrgs,
    createOrg,
    getOrg,
    listOrgMembers,
    addOrgMember,
    getTokenAllowlist,
    addOrgAllowedToken,
    removeOrgAllowedToken,
  };
}
