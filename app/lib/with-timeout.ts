/**
 * Request Timeout Helper
 *
 * Bounds long-running route work with a per-request deadline. The work
 * callback receives an AbortSignal it can honor for a graceful early stop;
 * when the deadline passes the signal aborts and the returned promise
 * rejects with TimeoutError, so the route can map it to a 504 envelope.
 */

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Operation timed out after ${timeoutMs}ms.`);
    this.name = "TimeoutError";
  }
}

export async function runWithTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();

  // Registered before work() so on abort the race rejects with TimeoutError
  // even when the work promise settles from its own abort listener.
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new TimeoutError(timeoutMs)),
      { once: true },
    );
  });

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let workPromise: Promise<T> | undefined;
  try {
    workPromise = work(controller.signal);
    return await Promise.race([workPromise, timedOut]);
  } finally {
    clearTimeout(timer);
    // Neither race loser may surface as an unhandled rejection.
    workPromise?.catch(() => undefined);
    timedOut.catch(() => undefined);
  }
}
