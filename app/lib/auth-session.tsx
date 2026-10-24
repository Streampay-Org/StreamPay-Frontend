"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

const SESSION_STORAGE_KEY = "streampay.auth.jwt";

export interface AuthSessionValue {
  /** Raw bearer token, or null when signed out. */
  token: string | null;
  setToken(token: string | null): void;
  /** Registers the 401-recovery flow (wallet sign-in challenge). */
  registerRecovery(handler: (() => Promise<void>) | null): void;
  /** Runs the registered recovery flow — used after a 401 response. */
  recover(): Promise<void>;
}

const AuthSessionContext = createContext<AuthSessionValue | null>(null);

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const recoveryRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored) setTokenState(stored);
    } catch {
      // Storage can be unavailable (private mode); stay signed out.
    }
  }, []);

  const setToken = useCallback((next: string | null) => {
    setTokenState(next);
    try {
      if (next) sessionStorage.setItem(SESSION_STORAGE_KEY, next);
      else sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore write failures; in-memory state remains authoritative.
    }
  }, []);

  const registerRecovery = useCallback((handler: (() => Promise<void>) | null) => {
    recoveryRef.current = handler;
  }, []);

  const recover = useCallback(async () => {
    const handler = recoveryRef.current;
    if (!handler) return;
    await handler();
  }, []);

  const value = useMemo(
    () => ({ token, setToken, registerRecovery, recover }),
    [token, setToken, registerRecovery, recover],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionValue {
  const value = useContext(AuthSessionContext);
  if (!value) {
    throw new Error("useAuthSession must be used inside <AuthSessionProvider>.");
  }
  return value;
}

/**
 * Fetch wrapper that attaches `Authorization: Bearer …` to API calls and
 * triggers the recovery flow on a 401 so clients can re-authenticate
 * (#1670). The original 401 response is always returned so callers can
 * still render the failure.
 */
export function useAuthFetch() {
  const { token, setToken, recover } = useAuthSession();

  return useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(
        input instanceof Request ? (init.headers ?? input.headers) : init.headers,
      );
      if (token && !headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      const response = await fetch(input, { ...init, headers });
      if (response.status === 401) {
        setToken(null);
        await recover();
      }
      return response;
    },
    [token, setToken, recover],
  );
}
