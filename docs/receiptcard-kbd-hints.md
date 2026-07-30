# ReceiptCard Keyboard Shortcut Hints (v7)

## Overview
Issue #1064 for the GrantFox FWC26 campaign (Stellar Wave) introduces keyboard shortcut hints to `ReceiptCard` (`app/ReceiptCard.tsx`) and adds a reusable `KbdHint` component (`src/components/KbdHint.tsx`).

## Components & Changes

### 1. `src/components/KbdHint.tsx`
A reusable, accessible component for rendering keyboard shortcuts formatted with semantic `<kbd>` tags and StreamPay design tokens.

- **Props**:
  - `keys`: `string | string[]` — Single key (e.g. `"C"`), key array (e.g. `["Ctrl", "C"]`), or combined key string (e.g. `"Ctrl+C"`).
  - `variant`: `"default" | "outline" | "subtle"` — Styling variant using design tokens.
  - `size`: `"sm" | "md"` — Component sizing.
  - `ariaLabel`: `string` — Custom screen reader label (defaults to `"Keyboard shortcut: [keys]"`).
  - `className`: `string` — Additional CSS class names.
  - `style`: `React.CSSProperties` — Custom inline styles.
  - `testId`: `string` — Test selector identifier (`default: "kbd-hint"`).

### 2. `app/ReceiptCard.tsx`
`ReceiptCard` now includes keyboard shortcut hints for its primary action triggers:
- **Masking toggle**: Press `M` to toggle recipient address privacy masking.
- **Copying receipt**: Press `C` to copy the formatted receipt text to clipboard.

- **API Changes**:
  - Added `showKbdHints?: boolean` (default: `true`) to `ReceiptCardProps`.
  - Added `aria-keyshortcuts="M"` to the Mask input checkbox.
  - Added `aria-keyshortcuts="C"` to the Copy share button.
  - Added keyboard event listeners (`keydown`) for `C` and `M` shortcuts, scoped to ignore typing inside editable form controls (`<input type="text">`, `<textarea>`, `<select>`).

### 3. `app/ReceiptCard.module.css`
Updated layout styles on `.maskLabel` and `.copyBtn` to use flex layout (`display: inline-flex; align-items: center; gap: 6px;`) so keyboard shortcut hints align visually across all responsive breakpoints.

## Accessibility (WCAG 2.1 AA)
- **2.1.1 Keyboard Navigation**: All card actions can be operated via single-key shortcuts (`C` and `M`) as well as standard focus & click/space/enter navigation.
- **2.5.4 Short Key Modifiers / 2.1.4 Character Key Shortcuts**: Shortcut listeners turn off when focus is inside text entry inputs to avoid accidental triggers while typing.
- **4.1.2 Name, Role, Value**: `aria-keyshortcuts` attributes programmatically expose keyboard shortcuts to screen readers and assistive technology.
- **Design Token Consistency**: Utilizes `var(--panel-elevated)`, `var(--foreground)`, `var(--border)`, and `var(--font-mono)` for consistent dark/light mode rendering with compliant contrast ratios.

## Testing
- `src/components/KbdHint.test.tsx`:
  - Renders single key, key array, and delimited key strings.
  - Verifies screen reader `aria-label` output.
  - Validates styling variants and prop forwarding.
- `app/ReceiptCard.test.tsx`:
  - Validates default rendering of `receipt-kbd-mask` and `receipt-kbd-copy`.
  - Verifies hiding hints when `showKbdHints={false}`.
  - Tests keydown events for `'c'` and `'m'`.
  - Confirms text inputs block shortcut triggers.
