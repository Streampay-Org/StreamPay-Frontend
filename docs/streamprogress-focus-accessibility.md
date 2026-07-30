# StreamProgress — Keyboard Focus Accessibility

## Overview
`StreamProgress` (`app/components/StreamProgress.tsx`) renders the burn-down
progress bar for a payment stream. Previously the `role="progressbar"` track
had no `tabIndex`, so keyboard-only users could never reach it and it never
received a visible focus indicator.

## Change
- The track now sets `tabIndex={0}`, placing it in the natural tab order
  alongside the rest of the stream row.
- `app/styles/focus.css` — the shared `focus-visible` layer used across the
  app — now includes `.stream-progress__track` in its selector list, so the
  track gets the same 2px accent-colored outline (with a background-safe
  `box-shadow` offset) as every other interactive element when focused via
  keyboard, and no outline at all for mouse/touch interaction
  (`:focus:not(:focus-visible)`).

No new CSS values were introduced — the fix reuses the existing
`--accent` / `--background` design tokens, so it is automatically correct
across the app's light, dark, and high-contrast themes.

## Accessibility (WCAG 2.1 AA)
- **2.4.7 Focus Visible**: the progress track now shows a visible focus
  indicator when reached via keyboard.
- **2.1.1 Keyboard**: the track is reachable via `Tab`/`Shift+Tab`.
- Focusing the track surfaces `aria-valuetext` (e.g. "42% accrued") to
  screen readers, giving keyboard/AT users a way to query the current
  progress value without a mouse.
- Color is still not the only signal — the visible `%` label next to the
  bar is unchanged.

## Testing
- `app/components/StreamProgress.test.tsx` — asserts the track has
  `tabIndex="0"` and that it accepts real DOM focus.
- `app/styles/focus.css.test.tsx` — asserts `.stream-progress__track` is
  present in the shared focus-visible layer.

## Manual verification
1. Tab through a page containing a `StreamRow`/`StreamProgress` (e.g. the
   streams list) using only the keyboard.
2. Confirm the progress bar receives a visible accent-colored outline when
   focused via `Tab`, and no outline when clicked with a mouse.
3. Confirm the outline is visible in both light and dark themes.
