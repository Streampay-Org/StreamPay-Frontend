// Expose Web Fetch API globals required by next/server at class-definition time.
// In jsdom environments, these are not present on the window global by default.
// In node environments, they are on globalThis but may not be on global.
// This file runs via setupFiles (before any test modules are imported).
const nodeFetch = {
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  fetch: globalThis.fetch,
};
for (const [key, value] of Object.entries(nodeFetch)) {
  if (value !== undefined && typeof global[key] === "undefined") {
    global[key] = value;
  }
}
