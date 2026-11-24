#!/usr/bin/env bash
# operations/verify-deploy.sh
# Verify that a deployed StreamPay contract's wasm hash matches the locally
# built wasm file.
#
# Usage:
#   bash operations/verify-deploy.sh \
#     --contract-id C... \
#     --wasm-file contracts/target/wasm32v1-none/release/streampay-stream.wasm \
#     --network testnet
#
# Environment variables (flags take precedence):
#   CONTRACT_ID      Deployed contract id
#   WASM_FILE        Local wasm file to compare
#   NETWORK          Network name (default: STELLAR_NETWORK or testnet)
#   STELLAR_NETWORK  Network name fallback
#   RPC_URL          Custom RPC URL (default: STELLAR_RPC_URL)
#   STELLAR_RPC_URL  RPC URL fallback
#   VERIFY_SKIP      Set to "true" to skip verification entirely
#
# The on-chain hash is read with:
#   stellar contract info hash --id <CONTRACT_ID> --network <NETWORK>
# (verified against the stellar-cli `contract info hash` subcommand). Older
# CLI builds without that subcommand fall back to:
#   stellar contract fetch --id <CONTRACT_ID> --network <NETWORK> -o <tmp>
# followed by a local sha256 of the fetched wasm.
#
# Works on Linux (`sha256sum`) and macOS (`shasum -a 256`).

set -euo pipefail

# ── Safety guard ────────────────────────────────────────────────────────────────
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "[verify] ERROR: Refusing to run in NODE_ENV=production." >&2
  echo "[verify] This script is for testnet/development only." >&2
  exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────────
log() { echo "[verify] $*"; }
err() { echo "[verify] ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: verify-deploy.sh [options]

Options:
  -c, --contract-id <id>     Deployed contract id (env: CONTRACT_ID)
  -w, --wasm-file <path>     Local wasm file (env: WASM_FILE)
  -n, --network <name>       Network name (env: NETWORK, default testnet)
      --rpc-url <url>        Custom RPC URL (env: RPC_URL)
      --dry-run              Print the local hash and skip the on-chain check
  -h, --help                 Show this help

Set VERIFY_SKIP=true to skip verification entirely.
EOF
}

hash_file() {
  local file="$1"
  local output

  if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum "$file")
  elif command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256 "$file")
  else
    err "Neither sha256sum nor shasum is available."
  fi

  printf '%s\n' "$output" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
}

# ── Arguments ───────────────────────────────────────────────────────────────────
CONTRACT_ID="${CONTRACT_ID:-}"
WASM_FILE="${WASM_FILE:-}"
NETWORK="${NETWORK:-${STELLAR_NETWORK:-testnet}}"
RPC_URL="${RPC_URL:-${STELLAR_RPC_URL:-}}"
VERIFY_SKIP="${VERIFY_SKIP:-false}"
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--contract-id)
      [[ -n "${2:-}" ]] || err "Missing value for $1"
      CONTRACT_ID="$2"
      shift 2
      ;;
    -w|--wasm-file)
      [[ -n "${2:-}" ]] || err "Missing value for $1"
      WASM_FILE="$2"
      shift 2
      ;;
    -n|--network)
      [[ -n "${2:-}" ]] || err "Missing value for $1"
      NETWORK="$2"
      shift 2
      ;;
    --rpc-url)
      [[ -n "${2:-}" ]] || err "Missing value for $1"
      RPC_URL="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      ;;
  esac
done

if [[ "$VERIFY_SKIP" == "true" ]]; then
  log "Verification skipped (VERIFY_SKIP=true)."
  exit 0
fi

[[ -n "$WASM_FILE" ]] || err "WASM_FILE is required (--wasm-file or env)."
[[ -f "$WASM_FILE" ]] || err "WASM file not found: $WASM_FILE"

local_hash=$(hash_file "$WASM_FILE")
log "Local wasm sha256: $local_hash"

if [[ "$DRY_RUN" == "true" ]]; then
  log "Dry run: skipping on-chain hash comparison."
  exit 0
fi

[[ -n "$CONTRACT_ID" ]] || err "CONTRACT_ID is required (--contract-id or env)."
command -v stellar >/dev/null 2>&1 || err "stellar CLI is required."

NETWORK_ARGS=(--network "$NETWORK")
if [[ -n "$RPC_URL" ]]; then
  NETWORK_ARGS+=(--rpc-url "$RPC_URL")
fi

# ── On-chain hash ───────────────────────────────────────────────────────────────
if info_output=$(stellar contract info hash --id "$CONTRACT_ID" "${NETWORK_ARGS[@]}" 2>/dev/null); then
  onchain_hash=$(printf '%s\n' "$info_output" \
    | grep -Eo '[0-9a-fA-F]{64}' \
    | tail -n 1 \
    | tr '[:upper:]' '[:lower:]' || true)

  [[ -n "$onchain_hash" ]] || err "Could not parse a wasm hash from stellar output: $info_output"
else
  log "stellar contract info hash unavailable; falling back to stellar contract fetch."
  tmp_file=$(mktemp "${TMPDIR:-/tmp}/streampay-wasm.XXXXXX")
  trap 'rm -f "$tmp_file"' EXIT

  if ! stellar contract fetch --id "$CONTRACT_ID" "${NETWORK_ARGS[@]}" -o "$tmp_file" >/dev/null 2>&1; then
    err "Failed to fetch wasm for $CONTRACT_ID from $NETWORK."
  fi

  onchain_hash=$(hash_file "$tmp_file")
fi

log "On-chain wasm sha256: $onchain_hash"

if [[ "$local_hash" != "$onchain_hash" ]]; then
  err "Wasm hash mismatch for $CONTRACT_ID on $NETWORK.
  local:    $local_hash
  on-chain: $onchain_hash"
fi

log "Wasm hash verified for $CONTRACT_ID on $NETWORK."
