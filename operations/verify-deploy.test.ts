/**
 * @jest-environment node
 */

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PROJECT_DIR = join(__dirname, "..");
const SCRIPT = join(PROJECT_DIR, "operations", "verify-deploy.sh");
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const LOCAL_HASH = createHash("sha256").update(WASM_BYTES).digest("hex");

const STUB_STELLAR = `#!/usr/bin/env bash
set -euo pipefail

hash_wasm() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ "\${1:-}" == "contract" && "\${2:-}" == "info" && "\${3:-}" == "hash" ]]; then
  if [[ "\${STUB_INFO_FAIL:-false}" == "true" ]]; then
    echo "info hash unavailable" >&2
    exit 4
  fi
  if [[ -n "\${STUB_ONCHAIN_HASH:-}" ]]; then
    printf '%s\\n' "$STUB_ONCHAIN_HASH"
  else
    hash_wasm "$STUB_WASM_SOURCE"
  fi
  exit 0
fi

if [[ "\${1:-}" == "contract" && "\${2:-}" == "fetch" ]]; then
  out=""
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "-o" || "$prev" == "--out-file" ]]; then
      out="$arg"
    fi
    prev="$arg"
  done
  [[ -n "$out" ]] || { echo "missing -o" >&2; exit 2; }
  cp "$STUB_WASM_SOURCE" "$out"
  exit 0
fi

echo "unexpected stellar args: $*" >&2
exit 3
`;

let tempDir: string;
let binDir: string;
let wasmFile: string;

function runVerify(
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      STUB_WASM_SOURCE: wasmFile,
      ...env,
    },
  });
}

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "streampay-verify-"));
  binDir = join(tempDir, "bin");
  mkdirSync(binDir);
  wasmFile = join(tempDir, "streampay-stream.wasm");
  writeFileSync(wasmFile, WASM_BYTES);

  const stubPath = join(binDir, "stellar");
  writeFileSync(stubPath, STUB_STELLAR);
  chmodSync(stubPath, 0o755);
});

afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

function verifyArgs(overrides: { contractId?: string; wasm?: string } = {}) {
  return [
    "--contract-id",
    overrides.contractId ?? CONTRACT_ID,
    "--wasm-file",
    overrides.wasm ?? wasmFile,
    "--network",
    "testnet",
  ];
}

describe("operations/verify-deploy.sh", () => {
  it("exits 0 when the on-chain hash matches", () => {
    const result = runVerify(verifyArgs());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(LOCAL_HASH);
    expect(result.stdout).toContain("Wasm hash verified");
  });

  it("compares hashes case-insensitively", () => {
    const result = runVerify(verifyArgs(), {
      STUB_ONCHAIN_HASH: LOCAL_HASH.toUpperCase(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Wasm hash verified");
  });

  it("exits non-zero and prints both hashes on mismatch", () => {
    const onchain = "0".repeat(64);
    const result = runVerify(verifyArgs(), { STUB_ONCHAIN_HASH: onchain });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mismatch");
    expect(result.stderr).toContain(LOCAL_HASH);
    expect(result.stderr).toContain(onchain);
  });

  it("falls back to stellar contract fetch when info hash is unavailable", () => {
    const result = runVerify(verifyArgs(), { STUB_INFO_FAIL: "true" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("falling back to stellar contract fetch");
    expect(result.stdout).toContain("Wasm hash verified");
  });

  it("supports --dry-run without an on-chain lookup", () => {
    const result = runVerify([
      "--dry-run",
      "--wasm-file",
      wasmFile,
      "--network",
      "testnet",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(LOCAL_HASH);
    expect(result.stdout).toContain("Dry run");
  });

  it("supports VERIFY_SKIP=true for offline use", () => {
    const result = runVerify([], { VERIFY_SKIP: "true" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verification skipped");
  });

  it("fails when the wasm file is missing", () => {
    const result = runVerify(verifyArgs({ wasm: join(tempDir, "missing.wasm") }));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("WASM file not found");
  });

  it("fails when the contract id is missing", () => {
    const result = runVerify(["--wasm-file", wasmFile, "--network", "testnet"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("CONTRACT_ID is required");
  });

  it("refuses to run when NODE_ENV=production", () => {
    const result = runVerify(verifyArgs(), { NODE_ENV: "production" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to run in NODE_ENV=production");
  });
});
