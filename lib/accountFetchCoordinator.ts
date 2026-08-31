/**
 * Account Fetch Coordinator
 *
 * Prevents race conditions between asynchronous data fetching and account switches.
 *
 * In Web3 and multi-account applications, asynchronous network fetches for a previously
 * active account can resolve after the user has already switched accounts. This module
 * guarantees:
 * 1. Epoch-based request gating: In-flight requests for older accounts or older request generations
 *    cannot mutate state or resolve for the new account.
 * 2. Automatic cancellation: In-flight HTTP/RPC requests for previous accounts are actively aborted via AbortController.
 * 3. Safe retry cycles: Exponential backoff retries check account validity before each attempt.
 * 4. Deduplication: Concurrent identical requests for the same account share a single in-flight promise.
 * 5. Deterministic state transitions: Loading, error, retry, and stale states are always scoped to the active account.
 */

export class AccountSwitchedError extends Error {
  readonly requestedAccount: string;
  readonly activeAccount: string | null;
  readonly isAccountSwitch = true;

  constructor(requestedAccount: string, activeAccount: string | null) {
    super(
      `Fetch for account '${requestedAccount}' was discarded because active account switched to '${activeAccount ?? "disconnected"}'.`
    );
    this.name = "AccountSwitchedError";
    this.requestedAccount = requestedAccount;
    this.activeAccount = activeAccount;
  }
}

export class RequestAbortedError extends Error {
  readonly isAborted = true;

  constructor(message = "Request was cancelled.") {
    super(message);
    this.name = "RequestAbortedError";
  }
}

export interface AccountFetchOptions {
  /** Optional deduplication key for coalescing identical concurrent requests */
  dedupKey?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Number of retry attempts on transient failures (default: 0) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;
  /** Whether to use exponential backoff for retries (default: true) */
  useExponentialBackoff?: boolean;
  /** Optional custom signal to compose with account abort signal */
  signal?: AbortSignal;
}

export interface InFlightEntry<T> {
  promise: Promise<T>;
  controller: AbortController;
  accountId: string;
  epoch: number;
}

export class AccountFetchCoordinator {
  private activeAccountId: string | null = null;
  private epoch = 0;
  private inFlightControllers = new Map<string, Set<AbortController>>();
  private deduplicationMap = new Map<string, InFlightEntry<unknown>>();

  constructor(initialAccountId: string | null = null) {
    this.activeAccountId = initialAccountId;
  }

  /**
   * Returns the currently active account ID, or null if disconnected.
   */
  getActiveAccountId(): string | null {
    return this.activeAccountId;
  }

  /**
   * Returns the current epoch counter. Increments on every account switch.
   */
  getEpoch(): number {
    return this.epoch;
  }

  /**
   * Transitions the active account. Aborts all in-flight requests for the prior account,
   * advances the epoch counter, and clears obsolete in-flight deduplications.
   */
  switchAccount(newAccountId: string | null): number {
    if (this.activeAccountId === newAccountId) {
      return this.epoch;
    }

    const previousAccountId = this.activeAccountId;
    this.activeAccountId = newAccountId;
    this.epoch += 1;
    const currentEpoch = this.epoch;

    // Abort all controllers associated with previous account
    if (previousAccountId) {
      const controllers = this.inFlightControllers.get(previousAccountId);
      if (controllers) {
        for (const controller of controllers) {
          try {
            controller.abort(new AccountSwitchedError(previousAccountId, newAccountId));
          } catch {
            // Ignore already aborted controllers
          }
        }
        this.inFlightControllers.delete(previousAccountId);
      }
    }

    // Clear deduplication map entries that do not match the new account and epoch
    for (const [key, entry] of this.deduplicationMap.entries()) {
      if (entry.accountId !== newAccountId || entry.epoch !== currentEpoch) {
        try {
          entry.controller.abort(new AccountSwitchedError(entry.accountId, newAccountId));
        } catch {
          // Ignore
        }
        this.deduplicationMap.delete(key);
      }
    }

    return currentEpoch;
  }

  /**
   * Executes a fetch strictly bound to a specific accountId.
   *
   * Invariants:
   * 1. If accountId !== activeAccountId at call time, throws AccountSwitchedError immediately.
   * 2. If account switches while fetch or retry is in progress, the operation is aborted and discarded.
   * 3. Concurrent calls with identical dedupKey for the active account share the same promise.
   */
  async execute<T>(
    accountId: string,
    fetcher: (signal: AbortSignal) => Promise<T>,
    options: AccountFetchOptions = {}
  ): Promise<T> {
    if (!accountId || accountId !== this.activeAccountId) {
      throw new AccountSwitchedError(accountId, this.activeAccountId);
    }

    const requestEpoch = this.epoch;
    const {
      dedupKey,
      timeoutMs = 30000,
      retries = 0,
      retryDelayMs = 1000,
      useExponentialBackoff = true,
      signal: externalSignal,
    } = options;

    // Check deduplication
    const compositeDedupKey = dedupKey ? `${accountId}:${dedupKey}` : null;
    if (compositeDedupKey) {
      const existing = this.deduplicationMap.get(compositeDedupKey);
      if (
        existing &&
        existing.accountId === accountId &&
        existing.epoch === requestEpoch &&
        !existing.controller.signal.aborted
      ) {
        return existing.promise as Promise<T>;
      }
    }

    const controller = new AbortController();

    // Register controller for active account
    if (!this.inFlightControllers.has(accountId)) {
      this.inFlightControllers.set(accountId, new Set());
    }
    const accountControllers = this.inFlightControllers.get(accountId)!;
    accountControllers.add(controller);

    // Link external abort signal if provided
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        const onExternalAbort = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    // Set timeout
    let timeoutId: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        controller.abort(new RequestAbortedError(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      accountControllers.delete(controller);
      if (accountControllers.size === 0) {
        this.inFlightControllers.delete(accountId);
      }
      if (compositeDedupKey) {
        this.deduplicationMap.delete(compositeDedupKey);
      }
    };

    const runWithRetries = async (): Promise<T> => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt++) {
        // Pre-attempt invariant check
        if (this.activeAccountId !== accountId || this.epoch !== requestEpoch || controller.signal.aborted) {
          throw new AccountSwitchedError(accountId, this.activeAccountId);
        }

        try {
          const result = await fetcher(controller.signal);

          // Post-resolution invariant check
          if (this.activeAccountId !== accountId || this.epoch !== requestEpoch || controller.signal.aborted) {
            throw new AccountSwitchedError(accountId, this.activeAccountId);
          }

          return result;
        } catch (error) {
          lastError = error;

          // If error was caused by account switch or explicit abort, stop retrying immediately
          if (
            error instanceof AccountSwitchedError ||
            (error instanceof Error && error.name === "AbortError" && controller.signal.aborted)
          ) {
            throw new AccountSwitchedError(accountId, this.activeAccountId);
          }

          if (attempt < retries) {
            const delay = useExponentialBackoff
              ? Math.min(retryDelayMs * Math.pow(2, attempt), 10000)
              : retryDelayMs;

            // Wait with abort safety
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve();
              }, delay);

              const onAbort = () => {
                clearTimeout(timer);
                reject(new AccountSwitchedError(accountId, this.activeAccountId));
              };

              controller.signal.addEventListener("abort", onAbort, { once: true });
            });

            // Post-sleep invariant check
            if (this.activeAccountId !== accountId || this.epoch !== requestEpoch) {
              throw new AccountSwitchedError(accountId, this.activeAccountId);
            }
          }
        }
      }

      throw lastError;
    };

    const fetchPromise = runWithRetries().finally(cleanup);

    if (compositeDedupKey) {
      this.deduplicationMap.set(compositeDedupKey, {
        promise: fetchPromise,
        controller,
        accountId,
        epoch: requestEpoch,
      });
    }

    return fetchPromise;
  }

  /**
   * Aborts all active requests across all accounts.
   */
  abortAll(reason = "All requests aborted."): void {
    for (const controllers of this.inFlightControllers.values()) {
      for (const controller of controllers) {
        try {
          controller.abort(new RequestAbortedError(reason));
        } catch {
          // Ignore
        }
      }
    }
    this.inFlightControllers.clear();
    this.deduplicationMap.clear();
  }
}

/** Global singleton coordinator for application-wide wallet fetches */
export const defaultAccountFetchCoordinator = new AccountFetchCoordinator();
