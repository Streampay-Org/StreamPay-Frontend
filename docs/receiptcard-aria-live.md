# ReceiptShareCard — aria-live Status Announcements

## Overview
`ReceiptShareCard` (`app/components/ReceiptShareCard.tsx`) has two pieces of
interactive state that change without moving keyboard focus or navigating the
page: the **copy-to-clipboard** button and the **mask address** toggle.
Previously, the only signal of a state change was a visual text swap
(`Copy` → `Copied`) and an `aria-label` update on the button — neither of
which is reliably announced by screen readers unless focus happens to be on
that exact element and the AT re-reads label changes.

## Change
- Added a new reusable `LiveRegion` component
  (`app/components/LiveRegion.tsx`): a visually-hidden (`sr-only`)
  `aria-live` region that announces its `message` prop whenever it changes,
  without rendering anything visible or moving focus. Supports `"polite"`
  (default, `role="status"`) and `"assertive"` (`role="alert"`).
- `ReceiptShareCard` now mounts one `LiveRegion` and updates its message on:
  - **Copy success** → `"Share text copied to clipboard."`
  - **Mask toggle** → `"Recipient address hidden."` / `"Recipient address shown."`
- This follows the same `sr-only` + `aria-live="polite"` + `role="status"`
  pattern already used ad hoc in `StreamRow.tsx` for its own SR
  announcements — `LiveRegion` is the reusable extraction of that pattern so
  future components don't have to hand-roll it.

## Accessibility (WCAG 2.1 AA)
- **4.1.3 Status Messages**: state changes are now programmatically
  announced to assistive technology without requiring a focus change.
- The live region is present in the DOM from first render (not conditionally
  mounted), which is required for `aria-live` to reliably pick up subsequent
  text changes in most screen readers.
- No visible UI or layout changed — `LiveRegion` renders via the existing
  `.sr-only` utility class, and no new colors/tokens were introduced, so
  light/dark/high-contrast theming is unaffected.

## Testing
- `app/components/LiveRegion.test.tsx` — politeness/role defaults, visual
  hiding, className forwarding, empty-message rendering.
- `app/components/ReceiptShareCard.test.tsx` — new `"aria-live
  announcements"` describe block: region present on mount, copy
  announcement, mask-hidden announcement, mask-shown announcement, and that
  the announcement text persists after the visible "Copied" button label
  resets (the announcement isn't tied to the button's transient visual
  state).

## Known limitation
Setting the same announcement text twice in a row (e.g. clicking "Copy"
twice within the same session before the message otherwise changes) may not
re-announce in every screen reader, since the DOM text doesn't change. This
matches the existing `StreamRow` announcement pattern and wasn't introduced
by this change; a de-dupe/force-refresh strategy (e.g. suffixing a hidden
counter) can be added later if this proves disruptive in practice.
