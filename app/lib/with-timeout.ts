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

  let timedOutReject: ((reason?: any) => void) | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timedOutReject = reject;
  });

  const onAbort = () => {
    if (timedOutReject) {
      const rejectFn = timedOutReject;
      timedOutReject = undefined;
      rejectFn(new TimeoutError(timeoutMs));
    }
  };

  controller.signal.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let workPromise: Promise<T> | undefined;
  try {
    workPromise = work(controller.signal);
    return await Promise.race([workPromise, timedOut]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    timedOutReject = undefined;
    // Suppress unhandled rejections on race loss
    workPromise?.catch(() => undefined);
    timedOut.catch(() => undefined);
  }
}
