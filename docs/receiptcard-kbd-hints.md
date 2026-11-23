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

## Complete keyboard shortcut reference (issue #1649)

Every shortcut in StreamPay is declared once in `lib/shortcuts.ts`. That module
is the single source of truth for the `?` overlay
(`app/components/ShortcutsOverlay.tsx`), the Help FAQ
(`app/help/page.tsx`) and the create-stream form hints
(`app/CreateStreamForm.tsx`). Editing the registry updates all three surfaces,
this table, and `lib/shortcuts.test.ts` — there is no second copy to drift.

| Context | Keys | What it does |
| --- | --- | --- |
| Global | `?` | Show keyboard shortcuts |
| Global | `⌘/Ctrl + K` | Open command palette |
| Global | `Esc` | Close dialogs |
| Navigation | `Tab` | Move focus forward |
| Navigation | `Shift + Tab` | Move focus backward |
| Navigation | `↑ + ↓` | Navigate lists |
| Navigation | `← + →` | Navigate tabs |
| Navigation | `Home` | First tab |
| Navigation | `End` | Last tab |
| Navigation | `Enter` | Select or activate |
| Create stream form | `Ctrl + ↵` | Submit the form |
| Create stream form | `Esc` | Cancel and close the form |
| Create stream form | `Alt + R` | Jump focus to the recipient field |
| Create stream form | `Alt + A` | Jump focus to the amount field |
| Receipt card | `M` | Toggle recipient address masking |
| Receipt card | `C` | Copy the formatted receipt text |

### Scoping rules

- `Alt+R` / `Alt+A` only apply while the create-stream form is mounted, and the
  overlay now lists them under the **Create stream form** heading.
- `Ctrl + ↵` submits the create-stream form and is ignored unless focus is in a
  text-entry control, so it never hijacks Enter elsewhere.
- `Esc` closes the create-stream form (the hint on the Cancel button) as well as
  dialogs, and is ignored when combined with Alt/Ctrl/Cmd.
- `M` / `C` are ReceiptCard-local single-key shortcuts; they are suppressed while
  focus is inside a text-entry control (see `lib/keyboard.ts`).

### Tests

- `lib/shortcuts.test.ts` — registry invariants: unique ids, context/scope
  agreement, one group per scope, no duplicate combo inside a scope, and the
  `Alt+R` / `Alt+A` context labels.
- `app/components/ShortcutsOverlay.test.tsx` — one overlay row per registry
  entry, and the form shortcuts shown under their context heading.
- `app/help/page.test.tsx` — the FAQ renders every registry entry, so the page
  cannot fall behind the overlay.
- `app/CreateStreamForm.test.tsx` — `Esc` cancels the form and the button hints
  render the registry keys verbatim.
