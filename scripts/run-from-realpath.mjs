import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("A command is required.");
  process.exit(1);
}

// Keep tool execution on the filesystem's canonical path so Next/Webpack
// don't see the project root under multiple casings on Windows.
const canonicalCwd = realpathSync.native(process.cwd());
process.chdir(canonicalCwd);

/**
 * Resolve the entrypoint for a locally-installed package binary.
 * This is more robust than hardcoding paths, which can vary.
 * @param {string} packageName The name of the npm package.
 * @returns {string} The resolved path to the executable.
 */
function resolveBin(packageName) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageJson = require(packageJsonPath);
  const binPath = packageJson.bin[packageName] || packageJson.bin;
  return path.join(path.dirname(packageJsonPath), binPath);
}

const localBinPackageMap = { eslint: 'eslint', jest: 'jest', next: 'next' };

function getLocalBin(commandName) {
  const packageName = localBinPackageMap[commandName];
  return packageName ? resolveBin(packageName) : undefined;
}

const localBin = getLocalBin(command);
const result = localBin
  ? spawnSync(process.execPath, [localBin, ...args], {
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
