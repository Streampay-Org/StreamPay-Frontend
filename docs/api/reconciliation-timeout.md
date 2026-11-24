# Reconciliation Per-Request Timeout

`POST /api/internal/reconciliation` now runs under a per-request deadline.

- The deadline defaults to 30 seconds and is tunable via the
  `RECONCILIATION_TIMEOUT_MS` environment variable, so operators can adjust
  it without a code deploy.
- The route wraps its work in `runWithTimeout` (`app/lib/with-timeout.ts`),
  which hands the work an `AbortSignal`. `ReconciliationService` honors the
  signal between streams: it stops before checking the next stream, records
  an abort error in the report, and skips the last-run-status DB write so a
  partial run is never recorded as a completed one.
- When the deadline passes, the response is `504` with the standard envelope
  and code `RECONCILIATION_TIMEOUT`. The response returns immediately; the
  service stops its loop at the next between-streams signal check. An
  individual in-flight on-chain or DB fetch is not interruptible (those
  clients do not accept a signal), so at most one fetch may still settle in
  the background after the 504.

Reconciliation over large stream sets previously had no bound: a hung
on-chain fetch held the request open indefinitely. The request is now always
bounded by the deadline even in that case; the abort checks additionally
stop the per-stream loop from continuing unobserved.
