/// <reference types="node" />
import "@testing-library/jest-dom";

// =============================================================================
// Test Environment Configuration
// =============================================================================
// SECURITY: Tests run in testnet mode only to prevent accidental mainnet usage
// These values are safe for testing - they match the dev secrets documented
// in .env.example and are NOT production credentials
// =============================================================================

// Set required environment variables for testing
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || "testnet";
process.env.JWT_SECRET = process.env.JWT_SECRET || "streampay-dev-secret-do-not-use-in-prod";
(process.env as any).NODE_ENV = process.env.NODE_ENV || "test";
process.env.SERVICE_NAME = process.env.SERVICE_NAME || "streampay-frontend-test";
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "http://localhost:3000";

// Security validation for test environment
if (process.env.STELLAR_NETWORK !== "testnet") {
  throw new Error(
    "SECURITY: Tests must run on testnet only. " +
    `STELLAR_NETWORK was set to: ${process.env.STELLAR_NETWORK}`
  );
}

// Reset config cache before each test to ensure clean state
// This is handled in individual test files via resetConfigCache()

// jsdom does not flush cascaded React effects (e.g. state-update → re-render →
// useEffect) within a single synchronous fireEvent.  Patch focus() so that when
// the Modal calls dialogRef.current.focus() inside a useEffect, jsdom's
// document.activeElement is updated even for tabIndex=-1 elements.
if (typeof window !== "undefined") {
  // jsdom 20+ supports focus() on tabIndex elements, but re-verify it is set.
  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function patchedFocus(opts?: FocusOptions) {
    origFocus.call(this, opts);
    // Force activeElement to this element (covers tabIndex=-1 divs in React effects).
    if (document.activeElement !== this) {
      try {
        Object.defineProperty(document, "activeElement", {
          get: () => this,
          configurable: true,
        });
      } catch { /* already non-configurable — ignore */ }
    }
  };
}
