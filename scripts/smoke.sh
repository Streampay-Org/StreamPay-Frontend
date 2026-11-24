#!/usr/bin/env bash
# scripts/smoke.sh — Unified smoke test entrypoint.
#
# Always runs the API smoke suite (OpenAPI validation, rateLimitIp, wallet
# routes).  When a Soroban contract ID and the stellar CLI are available,
# also runs the contract CLI smoke suite (scripts/smoke-contract.sh).
#
# Usage:
#   bash scripts/smoke.sh                              # API + contract (if env ready)
#   CONTRACT_ID=C... STELLAR_SEED_SECRET_KEY=S... bash scripts/smoke.sh
#   bash scripts/smoke.sh --contract                   # force contract tests
set -euo pipefail

cd "$(dirname "$0")/.."

PASSED=0; FAILED=0; SKIPPED=0
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; RESET='\033[0m'; BOLD='\033[1m'
else
  GREEN=''; RED=''; YELLOW=''; RESET=''; BOLD=''
fi
log()  { echo -e "${BOLD}[smoke]${RESET} $*"; }
pass() { echo -e "  ${GREEN}✓${RESET} $*"; PASSED=$((PASSED + 1)); }
fail() { echo -e "  ${RED}✗${RESET} $*" >&2; FAILED=$((FAILED + 1)); }
skip() { echo -e "  ${YELLOW}○${RESET} $*"; SKIPPED=$((SKIPPED + 1)); }

# ── Phase 1 — API smoke tests ──────────────────────────────────────────────────
log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log " Phase 1 — API Smoke Tests"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

api_exit=0
npm run smoke || api_exit=$?
if [ "$api_exit" -eq 0 ]; then
  pass "API smoke tests"
else
  fail "API smoke tests (exit $api_exit)"
fi

# ── Detect contract environment ────────────────────────────────────────────────
FORCE_CONTRACT=false
if [[ "${1:-}" == "--contract" ]]; then
  FORCE_CONTRACT=true
  shift
fi

CONTRACT_READY=false
CONTRACT_REASON=""
if command -v stellar &>/dev/null; then
  if [ -n "${CONTRACT_ID:-}" ]; then
    CONTRACT_READY=true
  elif [ -f "contracts/.contracts/streampay-stream.id" ]; then
    CONTRACT_READY=true
  else
    CONTRACT_REASON="CONTRACT_ID not set and contracts/.contracts/streampay-stream.id not found"
  fi
else
  CONTRACT_REASON="stellar CLI not found (install with: cargo install stellar-cli)"
fi

# ── Phase 2 — Contract CLI smoke tests ─────────────────────────────────────────
log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log " Phase 2 — Contract CLI Smoke Tests"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FORCE_CONTRACT" = true ] || [ "$CONTRACT_READY" = true ]; then
  if ! command -v stellar &>/dev/null; then
    fail "stellar CLI required for contract smoke"
  elif [ -z "${CONTRACT_ID:-}" ] && [ ! -f "contracts/.contracts/streampay-stream.id" ]; then
    fail "No contract ID available — set CONTRACT_ID or deploy first"
  else
    contract_exit=0
    bash scripts/smoke-contract.sh "$@" || contract_exit=$?
    if [ "$contract_exit" -eq 0 ]; then
      pass "Contract CLI smoke tests"
    else
      fail "Contract CLI smoke tests (exit $contract_exit)"
    fi
  fi
else
  skip "Contract CLI smoke tests — $CONTRACT_REASON"
fi

# ── Summary ─────────────────────────────────────────────────────────────────────
log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log " Results:  ${GREEN}${PASSED} passed${RESET}  |  ${RED}${FAILED} failed${RESET}  |  ${YELLOW}${SKIPPED} skipped${RESET}"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$FAILED" -gt 0 ]; then
  log "${RED}SMOKE TESTS FAILED${RESET}"
  exit 1
fi

log "${GREEN}All smoke tests passed.${RESET}"
