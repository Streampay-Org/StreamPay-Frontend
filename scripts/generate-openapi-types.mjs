#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "openapi.json");
const outputPath = join(root, "app", "types", "openapi.generated.ts");

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const generated = astToString(await openapiTS(spec));

if (process.argv.includes("--check")) {
  let existing;
  try {
    existing = readFileSync(outputPath, "utf8");
  } catch {
    console.error("Generated OpenAPI types are missing. Run npm run openapi:generate.");
    process.exit(1);
  }

  if (existing !== generated) {
    console.error("Generated OpenAPI types are out of date. Run npm run openapi:generate.");
    process.exit(1);
  }

  console.log("Generated OpenAPI types are up to date.");
} else {
  writeFileSync(outputPath, generated);
  console.log("Generated app/types/openapi.generated.ts from openapi.json.");
}