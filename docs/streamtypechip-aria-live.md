# StreamTypeChip — aria-live Status Announcements

## Overview
`StreamTypeChip` (`app/StreamTypeChip.tsx`) displays a stream type and amount.
When either value changes without moving keyboard focus, screen readers
previously received no reliable announcement. This change wires an
`aria-live` region so assistive technologies hear type and amount updates.

## Change
- Reuses `LiveRegion` from `src/components/LiveRegion.tsx` (sr-only +
  `role="status"` + `aria-live="polite"`).
- `StreamTypeChip` mounts one live region (`data-testid="stream-type-chip-live"`)
  and updates its message when props change:
  - **Type only** → `"Stream type changed to {type}"`
  - **Amount only** → `"Stream amount updated to {amount}"`
  - **Both** → `"Stream type {type}, amount {amount}"`
- Initial mount seeds internal refs and does **not** announce, avoiding
  false-positive chatter on first paint (same pattern as `StreamProgress`).

## Accessibility (WCAG 2.1 AA)
- **4.1.3 Status Messages**: prop-driven state changes are announced without
  requiring a focus change.
- The live region is present from first render so subsequent text updates
  are picked up by screen readers.
- No visible UI or layout change — announcements use the existing `.sr-only`
  utility. Reduced-motion and focus-visible behavior are unchanged.

## Testing
- `app/StreamTypeChip.test.tsx` — `"aria-live announcements"` suite covers
  region presence, empty initial message, type-only, amount-only, and
  combined updates.
- `src/components/LiveRegion.test.tsx` — shared LiveRegion unit coverage.

## Manual verification
1. Render a page with `StreamTypeChip` and enable a screen reader (or
   accessibility inspector showing live regions).
2. Change the `type` prop — confirm a polite announcement.
3. Change the `amount` prop — confirm a polite announcement.
4. Confirm the first paint does not announce.
