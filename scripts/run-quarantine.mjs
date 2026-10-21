import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const manifestPath = path.join(rootDir, "jest.quarantine.json");
if (!fs.existsSync(manifestPath)) {
  console.error("jest.quarantine.json manifest not found");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = manifest.entries || [];

console.log(`Running ${entries.length} quarantined suites...`);

const results = [];

// Determine jest binary command
// In this repo, npm test uses node scripts/run-from-realpath.mjs jest
const jestRunner = path.join(rootDir, "scripts", "run-from-realpath.mjs");

for (const entry of entries) {
  const filePath = entry.path;
  const proc = spawnSync(
    process.execPath,
    [
      jestRunner,
      "jest",
      filePath,
      "--testPathIgnorePatterns=/node_modules/",
      "--runInBand",
    ],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        CI: "true",
        NODE_ENV: "test",
      },
      encoding: "utf8",
    }
  );

  const passed = proc.status === 0;
  results.push({
    suite: filePath,
    status: passed ? "PASS" : "FAIL",
    reason: entry.reason || "",
  });
}

// Print summary table to stdout
console.log("\nQuarantined Suites Results:");
console.table(
  results.map((r) => ({
    Suite: r.suite,
    Status: r.status,
  }))
);

const passing = results.filter((r) => r.status === "PASS");
const failing = results.filter((r) => r.status === "FAIL");

console.log(`\nSummary: ${passing.length} passed, ${failing.length} failed, ${results.length} total.`);

if (passing.length > 0) {
  console.log("\nCandidates to un-quarantine (passing now):");
  passing.forEach((p) => console.log(`  - ${p.suite}`));
}

// Write to GITHUB_STEP_SUMMARY if available
if (process.env.GITHUB_STEP_SUMMARY) {
  let summaryContent = "## Quarantined Test Suites Summary\n\n";
  summaryContent += `| Status | Count |\n| --- | --- |\n| PASS | ${passing.length} |\n| FAIL | ${failing.length} |\n| Total | ${results.length} |\n\n`;
  summaryContent += "| Suite | Status | Reason |\n| --- | --- | --- |\n";
  for (const r of results) {
    const icon = r.status === "PASS" ? "PASS" : "FAIL";
    summaryContent += `| \`${r.suite}\` | ${icon} | ${r.reason} |\n`;
  }
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryContent, "utf8");
}

process.exit(0);
