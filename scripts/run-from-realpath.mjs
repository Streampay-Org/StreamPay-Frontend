import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("A command is required.");
  process.exit(1);
}

// Keep tool execution on the filesystem's canonical path so Next/Webpack
// don't see the project root under multiple casings on Windows.
const canonicalCwd = realpathSync.native(process.cwd());
process.chdir(canonicalCwd);

const localBins = {
  eslint: path.join(canonicalCwd, "node_modules", "eslint", "bin", "eslint.js"),
  jest: path.join(canonicalCwd, "node_modules", "jest", "bin", "jest.js"),
  next: path.join(canonicalCwd, "node_modules", "next", "dist", "bin", "next"),
};

const result = localBins[command]
  ? spawnSync(process.execPath, [localBins[command], ...args], {
      cwd: canonicalCwd,
      stdio: "inherit",
    })
  : spawnSync(command, args, {
      cwd: canonicalCwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
