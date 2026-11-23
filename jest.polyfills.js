const crypto = require("crypto");
const { TextEncoder, TextDecoder } = require("util");
const streamWeb = require("stream/web");

if (typeof globalThis.setImmediate === "undefined") {
  globalThis.setImmediate = (fn, ...args) => setTimeout(fn, 0, ...args);
  globalThis.clearImmediate = (id) => clearTimeout(id);
}

if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.randomUUID === "undefined") {
  const gCrypto = globalThis.crypto || {};
  if (!gCrypto.randomUUID) {
    gCrypto.randomUUID = crypto.randomUUID;
  }
  globalThis.crypto = gCrypto;
}

if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (val) => (val === undefined ? undefined : JSON.parse(JSON.stringify(val)));
}

if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

if (streamWeb) {
  for (const key of Object.keys(streamWeb)) {
    if (typeof globalThis[key] === "undefined") {
      globalThis[key] = streamWeb[key];
    }
  }
}

if (typeof window !== "undefined") {
  window.setImmediate = window.setImmediate || globalThis.setImmediate;
  window.clearImmediate = window.clearImmediate || globalThis.clearImmediate;
  window.crypto = window.crypto || globalThis.crypto;
  if (!window.crypto.randomUUID) {
    window.crypto.randomUUID = crypto.randomUUID;
  }
  if (typeof window.crypto.getRandomValues === "undefined") {
    window.crypto.getRandomValues = crypto.getRandomValues.bind(crypto);
  }
  window.structuredClone = window.structuredClone || globalThis.structuredClone;
  window.TextEncoder = window.TextEncoder || TextEncoder;
  window.TextDecoder = window.TextDecoder || TextDecoder;
  if (streamWeb) {
    for (const key of Object.keys(streamWeb)) {
      window[key] = window[key] || streamWeb[key];
    }
  }
}

if (typeof global !== "undefined") {
  global.setImmediate = global.setImmediate || globalThis.setImmediate;
  global.clearImmediate = global.clearImmediate || globalThis.clearImmediate;
  global.crypto = global.crypto || globalThis.crypto;
  if (!global.crypto.randomUUID) {
    global.crypto.randomUUID = crypto.randomUUID;
  }
  if (typeof global.crypto.getRandomValues === "undefined") {
    global.crypto.getRandomValues = crypto.getRandomValues.bind(crypto);
  }
  global.structuredClone = global.structuredClone || globalThis.structuredClone;
  global.TextEncoder = global.TextEncoder || TextEncoder;
  global.TextDecoder = global.TextDecoder || TextDecoder;
  if (streamWeb) {
    for (const key of Object.keys(streamWeb)) {
      global[key] = global[key] || streamWeb[key];
    }
  }
}

const edgePrimitives = require("next/dist/compiled/@edge-runtime/primitives");
if (edgePrimitives) {
  const G = typeof window !== "undefined" ? window : globalThis;
  G.Request = G.Request || edgePrimitives.Request;
  G.Response = G.Response || edgePrimitives.Response;
  G.Headers = G.Headers || edgePrimitives.Headers;
  G.fetch = G.fetch || edgePrimitives.fetch;
  if (typeof global !== "undefined") {
    global.Request = global.Request || edgePrimitives.Request;
    global.Response = global.Response || edgePrimitives.Response;
    global.Headers = global.Headers || edgePrimitives.Headers;
    global.fetch = global.fetch || edgePrimitives.fetch;
  }
}
