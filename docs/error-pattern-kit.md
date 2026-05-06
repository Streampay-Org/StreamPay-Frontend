# Error Pattern Kit — Stellar & StreamPay Money-Movement Flows

**Issue:** #47  
**Status:** Design handoff — Figma kit pending attachment  
**Scope:** UX/design only. No Next.js implementation in this PR.

---

## Error Archetypes

| # | Archetype | `problem+json` code | Severity | Component |
|---|-----------|---------------------|----------|-----------|
| 1 | Insufficient balance | `op_underfunded` | High | Error/Inline |
| 2 | Horizon / RPC outage | `horizon_unavailable` | Critical | Error/Blocking |
| 3 | Transaction rejected on-chain | `tx_failed` | High | Error/Banner |
| 4 | Wallet not connected | `wallet_disconnected` | Medium | Error/Inline |
| 5 | Stream escrow below minimum | `escrow_below_minimum` | High | Error/Inline |
| 6 | Network mismatch (testnet vs mainnet) | `network_mismatch` | Critical | Error/Blocking |

---

## Component Inventory

- **Error/Inline** — field-level or card-level; no full stack trace; optional "Details" accordion for advanced mode
- **Error/Banner** — page-level dismissible; includes request ID for support escalation
- **Error/Blocking** — full-page or modal; blocks action until resolved

## Suggested Next-Step Copy

| Code | Primary CTA | Secondary |
|------|-------------|-----------|
| `op_underfunded` | Add funds | View balance |
| `horizon_unavailable` | Try again | Check network status |
| `tx_failed` | Retry transaction | Contact support (ref: `{requestId}`) |
| `wallet_disconnected` | Connect wallet | — |
| `escrow_below_minimum` | Adjust amount | Learn more |
| `network_mismatch` | Switch network | — |

## A11y Notes

- Toasts: `role="alert"` + `aria-live="assertive"` for critical; `aria-live="polite"` for informational
- Color is never the sole severity indicator — icon + label always accompany color
- Grayscale print test required before v1 sign-off
- WCAG AA contrast minimum; phase-2 gaps documented in Figma annotations

## Handoff Checklist

- [ ] Figma file linked to this issue
- [ ] PDF export attached
- [ ] Design crit completed (product + eng sign-off noted in Figma)
- [ ] Named export assets listed in Figma handoff panel
- [ ] Redlines and component specs present (no orphan screens)

## Out of Scope

Implementation in the Next.js app is tracked as a separate frontend issue.
