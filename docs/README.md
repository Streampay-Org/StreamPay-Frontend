# StreamPay Documentation Index

Entry point for everything under `docs/`. Every page is listed exactly once, grouped by area.


## API

- [`ICS-EXPORT-API.md`](ICS-EXPORT-API.md) — ICS Calendar Export API Documentation
- [`SDK.md`](SDK.md) — StreamPay Partner SDK
- [`SSE-HEARTBEATS.md`](SSE-HEARTBEATS.md) — Bounded SSE Heartbeats and Dead-Client Detection
- [`api-client-usage.md`](api-client-usage.md) — API Client Usage
- [`api-v2-migration.md`](api-v2-migration.md) — StreamPay API v2 Migration Guide
- [`api/activity.md`](api/activity.md) — Activity feed
- [`api/admin.md`](api/admin.md) — Admin API Reference
- [`api/auth-wallet-openapi.md`](api/auth-wallet-openapi.md) — OpenAPI examples — /api/auth/wallet
- [`api/auth-wallet.md`](api/auth-wallet.md) — Wallet Auth Input Validation
- [`api/exports-access-logs.md`](api/exports-access-logs.md) — Structured Access Logs — /api/exports (v7)
- [`api/exports-etag.md`](api/exports-etag.md) — GET /api/exports — ETag / 304 (v7)
- [`api/idempotency-scoping.md`](api/idempotency-scoping.md) — Idempotency scoping for stream lifecycle routes
- [`api/multi-recipient-stream.md`](api/multi-recipient-stream.md) — Multi-Recipient Stream Creation API
- [`api/notifications-preferences.md`](api/notifications-preferences.md) — Notification Preferences API
- [`api/reconciliation-cursor.md`](api/reconciliation-cursor.md) — Reconciliation Overview API
- [`api/reconciliation-timeout.md`](api/reconciliation-timeout.md) — Reconciliation Per-Request Timeout
- [`api/reconciliation-validation.md`](api/reconciliation-validation.md) — /api/reconciliation Input Validation (v7)
- [`api/stream-search-fts.md`](api/stream-search-fts.md) — Stream Search API (Full-Text Search)
- [`api/stream-templates.md`](api/stream-templates.md) — Stream templates API and /templates page
- [`api/streams-cursor.md`](api/streams-cursor.md) — Stream list pagination cursors
- [`api/streams-metrics.md`](api/streams-metrics.md) — /api/streams per-endpoint Prometheus metrics
- [`api/streams-validation.md`](api/streams-validation.md) — /api/streams Input Validation
- [`api/webhooks-openapi.md`](api/webhooks-openapi.md) — OpenAPI examples — /api/webhooks
- [`caching.md`](caching.md) — HTTP Caching (ETag / 304 Short-Circuit)
- [`error-codes.md`](error-codes.md) — Error Codes Reference
- [`errors.md`](errors.md) — StreamPay Error Handling
- [`live-events-protocol.md`](live-events-protocol.md) — StreamPay Live Events Protocol (SSE)
- [`rate-limits.md`](rate-limits.md) — Rate Limiting
- [`supported-assets.md`](supported-assets.md) — Supported Assets (v1)
- [`webhook-delivery.md`](webhook-delivery.md) — Webhook Delivery with Exponential Backoff and DLQ

## Security

- [`BODY-SIZE-LIMITS.md`](BODY-SIZE-LIMITS.md) — Body Size Limit Configuration - Implementation Summary
- [`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) — Security CI Deployment Checklist
- [`PRIVACY.md`](PRIVACY.md) — Privacy & PII Handling
- [`SECURITY-CHECKLIST.md`](SECURITY-CHECKLIST.md) — Security Changes
- [`SECURITY-CI-SETUP.md`](SECURITY-CI-SETUP.md) — Security CI Setup Guide for Administrators
- [`SECURITY-SCANNING-GUIDE.md`](SECURITY-SCANNING-GUIDE.md) — Security Scanning Guide: SAST vs Runtime Vulnerabilities
- [`admin-circuit-breaker.md`](admin-circuit-breaker.md) — Admin Circuit Breaker
- [`audit-log.md`](audit-log.md) — Immutable Audit Log for Privileged and Financial Actions
- [`csrf-protection.md`](csrf-protection.md) — CSRF Protection Reference
- [`internal-service-auth.md`](internal-service-auth.md) — Internal Service Authentication
- [`k8s-security.md`](k8s-security.md) — Kubernetes Security Context for StreamPay
- [`network-security.md`](network-security.md) — Stellar Network Security Configuration
- [`request-fingerprinting.md`](request-fingerprinting.md) — Request Fingerprinting

## Observability and Ops

- [`cpu-instrumentation.md`](cpu-instrumentation.md) — CPU Instrumentation Documentation
- [`horizon-indexer.md`](horizon-indexer.md) — Horizon Events Indexer
- [`local-stellar.md`](local-stellar.md) — Local Stellar Testnet Setup
- [`metrics-api.md`](metrics-api.md) — Metrics API Documentation
- [`observability-tracing-guide.md`](observability-tracing-guide.md) — Observability and Tracing Guide
- [`observability.md`](observability.md) — Observability
- [`performance-initial-render.md`](performance-initial-render.md) — Initial Render Performance (issue #85)
- [`persistent-store-interface.md`](persistent-store-interface.md) — Persistent Store Interface
- [`reconciliation.md`](reconciliation.md) — Nightly Reconciliation
- [`slo-burn-alerts.md`](slo-burn-alerts.md) — P95 SLO Burn Alerts - Implementation Summary
- [`soroban-retry-queue.md`](soroban-retry-queue.md) — Soroban Retry Queue
- [`withdrawal-finality-slo.md`](withdrawal-finality-slo.md) — Withdrawal Finality SLO

## Contracts

- [`EVENT_TOPICS.md`](EVENT_TOPICS.md) — StreamPay Event Topic Catalog
- [`STATE_MACHINE.md`](STATE_MACHINE.md) — Stream State Machine
- [`STORAGE_LAYOUT.md`](STORAGE_LAYOUT.md) — Contract Storage Layout
- [`STREAM_MIGRATION_GUIDE.md`](STREAM_MIGRATION_GUIDE.md) — Stream Storage Migration Guide
- [`contract-events-panel.md`](contract-events-panel.md) — Contract Events Panel
- [`contract-events.md`](contract-events.md) — Contract events panel
- [`contract-smoke-tests.md`](contract-smoke-tests.md) — Contract CLI Smoke Tests
- [`fee-bump.md`](fee-bump.md) — Fee-Bump Support (GrantFox FWC26)
- [`invariants.md`](invariants.md) — Stream Invariants & Property Testing
- [`payout-math.md`](payout-math.md) — Payout Schedule Math
- [`stream-state-glossary.md`](stream-state-glossary.md) — Stream State Glossary

## Frontend/UI

- [`FIGMA-BREAKPOINTS-MODAL-SPEC.md`](FIGMA-BREAKPOINTS-MODAL-SPEC.md) — Figma Design Specification: Named Breakpoints and Modal Behavior
- [`STREAMTYPECHIP_EMPTY_STATE.md`](STREAMTYPECHIP_EMPTY_STATE.md) — StreamTypeChip Empty State (v7)
- [`TABS_COMPONENT_API.md`](TABS_COMPONENT_API.md) — Accessible Tabs Component - Settings Implementation
- [`THEME_NO_FLASH.md`](THEME_NO_FLASH.md) — Theme No-Flash Implementation
- [`WALLET_BADGE_REDUCED_MOTION.md`](WALLET_BADGE_REDUCED_MOTION.md) — WalletBadge Reduced-Motion Fallback (v7)
- [`WALLET_BADGE_RESPONSIVE.md`](WALLET_BADGE_RESPONSIVE.md) — WalletBadge Responsive Breakpoint Audit Specifications (v7)
- [`address-book.md`](address-book.md) — Address Book
- [`api/wallet-mru.md`](api/wallet-mru.md) — Wallet MRU Local State
- [`copy-address-accessibility.md`](copy-address-accessibility.md) — CopyAddress Component - Accessibility & Design Documentation
- [`createstreamform-focus-visible.md`](createstreamform-focus-visible.md) — CreateStreamForm — focus-visible Outline (#1046)
- [`design-qa-checklist.md`](design-qa-checklist.md) — StreamPay Design QA Checklist
- [`design_handoff_stellar_address.md`](design_handoff_stellar_address.md) — Design Handoff: Stellar Address Display & Trust Patterns
- [`merged-stream-chart.md`](merged-stream-chart.md) — MergedStreamChart component
- [`mru-wallet-ordering.md`](mru-wallet-ordering.md) — MRU Wallet Ordering
- [`receiptcard-aria-live.md`](receiptcard-aria-live.md) — ReceiptShareCard — aria-live Status Announcements
- [`receiptcard-kbd-hints.md`](receiptcard-kbd-hints.md) — ReceiptCard Keyboard Shortcut Hints (v7)
- [`streamprogress-focus-accessibility.md`](streamprogress-focus-accessibility.md) — StreamProgress — Keyboard Focus Accessibility
- [`streams-grid-keyboard.md`](streams-grid-keyboard.md) — Streams grid keyboard behavior
- [`streamtypechip-aria-live.md`](streamtypechip-aria-live.md) — StreamTypeChip — aria-live Status Announcements
- [`streamtypechip-cb-patterns.md`](streamtypechip-cb-patterns.md) — StreamTypeChip — Color-Blind Pattern Fills
- [`streamtypechip-focus-accessibility.md`](streamtypechip-focus-accessibility.md) — StreamTypeChip — Keyboard Focus Accessibility
- [`toast-queue.md`](toast-queue.md) — Toast queue
- [`uiux/bottom-nav-badges.md`](uiux/bottom-nav-badges.md) — Bottom Nav with Badges
- [`uiux/compare-streams-modal.md`](uiux/compare-streams-modal.md) — Compare Streams Modal
- [`uiux/figma-cover-and-handoff-policy.md`](uiux/figma-cover-and-handoff-policy.md) — StreamPay (Stellar) Figma Design System: Cover Page & Handoff Policy
- [`uiux/grantfox-ux-bundle.md`](uiux/grantfox-ux-bundle.md) — GrantFox UX Bundle
- [`uiux/streamrow-design-tokens-v7.md`](uiux/streamrow-design-tokens-v7.md) — StreamRow Spacing & Typography — Design Tokens v7
- [`uiux/streamrow-responsive-breakpoints-v7.md`](uiux/streamrow-responsive-breakpoints-v7.md) — StreamRow Responsive Breakpoints — v7
- [`uiux/tag-chip-filter.md`](uiux/tag-chip-filter.md) — Tag Chip Filter (GrantFox FWC26)

## Architecture and ADRs

- [`adr/0001-temporal-durable-workflows.md`](adr/0001-temporal-durable-workflows.md) — ADR 0001 — Temporal (or equivalent durable workflow engine) for long-lived stream schedules
- [`adr/001-org-stream-ownership.md`](adr/001-org-stream-ownership.md) — ADR-001 — Org-Owned and Multi-Signature Stream Ownership
- [`architecture.md`](architecture.md) — Architecture Overview
- [`backend-contributing.md`](backend-contributing.md) — Backend Contributing Guide
- [`glossary.md`](glossary.md) — Glossary
- [`reference.md`](reference.md) — streampay-frontend
- [`testing-guide.md`](testing-guide.md) — Testing Guide

## Runbooks

- [`reconciliation-runbook.md`](reconciliation-runbook.md) — Runbook: Stream Reconciliation Mismatch
- [`runbooks/RUNBOOK_SETTLEMENT_FAILURES.md`](runbooks/RUNBOOK_SETTLEMENT_FAILURES.md) — Runbook: Settlement Failures & DLQ Growth

## Misc

- [`IMPLEMENTATION-SUMMARY.md`](IMPLEMENTATION-SUMMARY.md) — Security CI Implementation Summary
- [`ISSUE-75-BREAKPOINTS-SUMMARY.md`](ISSUE-75-BREAKPOINTS-SUMMARY.md) — Issue #75: Figma Named Breakpoints and Modal Behavior
- [`deprecation-notice-template.md`](deprecation-notice-template.md) — Deprecation Notice Template
- [`refund-test-coverage.md`](refund-test-coverage.md) — Refund Splitting Test Coverage

## Adding a doc

- Put new pages in the area folder that fits: `api/` for endpoint references, `adr/` for architecture decisions, `runbooks/` for operational procedures, `uiux/` for design specs. General pages live at the top level of `docs/`.
- Prefer lowercase `kebab-case.md` names (for example `rate-limits.md`). Avoid new `UPPER_CASE` or `snake_case` names; existing ones are kept as-is so links do not break.
- Start the page with a single `#` heading that states what it covers; this index uses it for the one-line summary.
- Add the page to the matching section above and use relative links only.
