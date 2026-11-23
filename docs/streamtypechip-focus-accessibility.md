# StreamTypeChip — Keyboard Focus Accessibility

## Overview
`StreamTypeChip` (`app/StreamTypeChip.tsx`) displays the type and total amount for a payment stream. Previously, the chip was static and did not accept focus, so keyboard-only users could not reach it, and it did not have a visible focus indicator.

## Change
- The component now sets `tabIndex={0}` and adds a global `.stream-type-chip` class.
- `app/styles/focus.css` — the shared `focus-visible` layer — now includes `.stream-type-chip` in its selector list. This ensures the chip gets the standard 2px accent-colored outline with a background-safe `box-shadow` offset when focused via keyboard navigation, while suppressing the outline for mouse/touch interactions (`:focus:not(:focus-visible)`).

## Accessibility (WCAG 2.1 AA)
- **2.4.7 Focus Visible**: The chip displays a visible focus indicator when reached via keyboard.
- **2.1.1 Keyboard**: The chip is reachable in the natural keyboard tab order using `Tab`/`Shift+Tab`.
- **Screen Reader Support**: When focused, screen readers read the combined type and amount values (e.g., "Video 12345").

## Testing
- `app/StreamTypeChip.test.tsx` — asserts that the chip has `tabIndex="0"` and successfully receives DOM focus.
- `app/styles/focus.css.test.tsx` — asserts that `.stream-type-chip` is registered in both the keyboard-visible and suppression selector lists.

## Manual verification
1. Tab through a page containing `StreamTypeChip` using the keyboard.
2. Confirm that the chip receives the accent-colored outline when focused via `Tab`.
3. Confirm that clicking the chip with a mouse does not display the outline.
4. Verify the visibility of the outline in both light and dark themes.
