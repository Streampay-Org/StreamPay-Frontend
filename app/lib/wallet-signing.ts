/**
 * Wallet Transaction Signing (Cancellation-Safe)
 * 
 * Invariants:
 * 1. Least privilege: Only requests the necessary signing scope.
 * 2. Deterministic: "User declined" and AbortSignal aborts both yield a consistent `CancellationError`.
 * 3. Abuse resistance: Prevents concurrent signature requests that could spam the wallet or corrupt state.
 * 4. Authorization boundaries: Validates the payload/XDR before attempting to sign.
 */

export class CancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConcurrentSigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrentSigningError";
  }
}

// Global state to prevent concurrent signing requests
let isSigning = false;

// For testing purposes only
export function _resetSigningState() {
  isSigning = false;
}

export async function signTransactionSafe(
  xdr: string,
  signFn: (xdr: string) => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  // Authorization boundary & input validation
  if (!xdr || typeof xdr !== "string" || xdr.trim() === "") {
    throw new ValidationError("Invalid transaction XDR payload");
  }

  // Abuse resistance: prevent concurrent execution
  if (isSigning) {
    throw new ConcurrentSigningError("Concurrent signing requests are not permitted.");
  }

  if (signal?.aborted) {
    throw new CancellationError("Action cancelled before signing");
  }

  isSigning = true;

  return new Promise<string>((resolve, reject) => {
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      isSigning = false; // Release lock immediately on abort
      reject(new CancellationError("Action cancelled by system or user"));
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    signFn(xdr)
      .then((signedXdr) => {
        if (!aborted) {
          resolve(signedXdr);
        }
      })
      .catch((err) => {
        if (!aborted) {
          // Detect specific "user declined" errors from common wallet providers
          const errMsg = err instanceof Error ? err.message : String(err);
          const lowerMsg = errMsg.toLowerCase();
          const isUserDecline =
            lowerMsg.includes("user declined") ||
            lowerMsg.includes("reject") ||
            lowerMsg.includes("cancelled");

          if (isUserDecline) {
            reject(new CancellationError("User declined the transaction"));
          } else {
            reject(err);
          }
        }
      })
      .finally(() => {
        if (!aborted) {
          isSigning = false;
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      });
  });
}
