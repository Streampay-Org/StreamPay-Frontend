/**
 * Client-safe error module barrel.
 * Server routes should import errorResponse from ./server instead.
 */

export type {
  StreamPayError,
  ErrorHandler,
  ErrorFilter,
  ErrorPresentation,
  ErrorSeverity,
  BackendApiErrorResponse,
  HorizonError,
  ErrorNormalizationOptions,
} from "./types";

export {
  isRetryableError,
  getRetryGuidance,
  getUserMessage,
} from "./codes";

export {
  normalizeError,
  isStreamPayError,
  createError,
  isNetworkError,
} from "./mapper";

export {
  formatErrorForDisplay,
  handleError,
  hasFieldErrors,
  getFirstFieldError,
} from "./handler";

export function safeJsonStringify(v: unknown): string {
  const s = new Set<object>();
  const f = (x: any): any => {
    if (typeof x === "bigint") return x.toString();
    if (x === null || x === undefined || typeof x !== "object") return x;
    if (s.has(x)) return "[Circular]";
    s.add(x);
    let r: any;
    if (x instanceof Error) {
      r = { name: x.name, message: x.message };
      for (const k of Object.keys(x)) r[k] = f(x[k]);
    } else if (Array.isArray(x)) r = x.map(f);
    else { r = {}; for (const k of Object.keys(x)) r[k] = f(x[k]); }
    s.delete(x);
    return r;
  };
  return JSON.stringify(f(v)) ?? "undefined";
}
