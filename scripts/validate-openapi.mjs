#!/usr/bin/env node
/**
 * validate-openapi.mjs
 * Validates openapi.json against the codebase routes.
 * Run: node scripts/validate-openapi.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(__dirname, "..", "openapi.json");

let fatal = false;

function log(level, ...args) {
  console.error(`[${level}]`, ...args);
}

function checkField(obj, field, path, required = true) {
  const parts = field.split(".");
  let val = obj;
  for (const p of parts) {
    val = val?.[p];
  }
  if (required && (val === undefined || val === null)) {
    log("ERROR", `Missing required field: ${path}`);
    fatal = true;
    return null;
  }
  return val;
}

function checkEnum(value, allowed, path) {
  if (value && !allowed.includes(value)) {
    log("WARN", `Suspicious enum value "${value}" at ${path}, expected one of: ${allowed.join(", ")}`);
  }
}

async function main() {
  log("INFO", "Loading OpenAPI spec...");
  let spec;
  try {
    spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
  } catch (e) {
    log("ERROR", `Failed to parse openapi.json: ${e.message}`);
    process.exit(1);
  }

  log("INFO", "Validating OpenAPI 3.1 structure...");

  checkField(spec, "openapi", "openapi");
  if (spec.openapi !== "3.1.0") {
    log("ERROR", `Expected openapi version 3.1.0, got ${spec.openapi}`);
    fatal = true;
  }

  checkField(spec, "info.title", "info.title");
  checkField(spec, "info.version", "info.version");
  checkField(spec, "paths", "paths");

  const paths = spec.paths || {};
  const expectedPaths = [
    "/api/streams",
    "/api/streams/{id}",
    "/api/streams/{id}/start",
    "/api/streams/{id}/pause",
    "/api/streams/{id}/stop",
    "/api/streams/{id}/settle",
    "/api/v2/streams",
    "/api/v2/streams/{id}",
    "/api/v2/streams/{id}/start",
    "/api/v2/streams/{id}/pause",
    "/api/v2/streams/{id}/stop",
    "/api/v2/streams/{id}/settle",
    "/api/activity",
    "/api/auth/wallet",
  ];

  for (const ep of expectedPaths) {
    if (!paths[ep]) {
      log("ERROR", `Missing path in spec: ${ep}`);
      fatal = true;
    } else {
      log("OK", `Path found: ${ep}`);
    }
  }

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (["get", "post", "put", "delete", "patch"].includes(method)) {
        if (!operation.operationId) {
          log("WARN", `Missing operationId: ${method.toUpperCase()} ${path}`);
        }
        if (!operation.responses) {
          log("ERROR", `Missing responses for ${method.toUpperCase()} ${path}`);
          fatal = true;
        }
      }
    }
  }

  const schemas = spec.components?.schemas || {};
  const requiredSchemas = ["ErrorEnvelope", "StreamV1", "StreamV2"];
  for (const s of requiredSchemas) {
    if (!schemas[s]) {
      log("ERROR", `Missing schema: ${s}`);
      fatal = true;
    } else {
      log("OK", `Schema found: ${s}`);
    }
  }

  if (fatal) {
    log("ERROR", "OpenAPI validation FAILED");
    process.exit(1);
  }

  log("INFO", "OpenAPI validation PASSED");
  process.exit(0);
}

main().catch((e) => {
  log("ERROR", `Unexpected error: ${e.message}`);
  process.exit(1);
});
