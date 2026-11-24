# CreateStreamForm — focus-visible Outline (#1046)

## Overview
Issue #1046 for the GrantFox FWC26 campaign (Stellar Wave) adds visible
`:focus-visible` outlines on keyboard-only navigation for the
`CreateStreamForm` at `app/streams/new/page.tsx`.

Previously, the form's input fields used inline `border` styles that visually
overrode the shared focus layer from `app/styles/focus.css`. Mouse/touch users
were unaffected, but keyboard-only users saw no visible focus indicator when
tabbing through form controls — a WCAG 2.1 AA violation (2.4.7 Focus Visible).

## Changes

### `app/streams/new/page.tsx`
- Added `className="create-stream-form"` and `data-testid="create-stream-form"`
  to the `<form>` element as a scoping hook for CSS targeting.
- Added `className="csf-field"` to all interactive form children:
  - Recipient `<input>` (`#recipient`)
  - Amount `<input>` (`#amount`)
  - Token `<select>` (`#token`)
  - Cancel `<button>` (`.button--secondary`)
  - Create Stream `<button>` (`.button--primary`)

### `app/styles/focus.css`
- Added `.csf-field` to the shared `:focus-visible` and `:focus:not(:focus-visible)`
  selector lists so keyboard focus rings apply universally.
- Added a dedicated `.create-stream-form .csf-field:focus-visible` rule that:
  - Renders `outline: 2px solid var(--accent)` with `outline-offset: 2px`
  - Adds a contrasting `box-shadow: 0 0 0 2px var(--background)` ring
  - Overrides the inline `border-color` to `var(--accent)` using `!important`
    to visually reinforce the active field (the `!important` is scoped and
    necessary because the form uses inline styles for field borders)
  - Adds a `transition` for smooth visual feedback
- Added corresponding `.create-stream-form .csf-field:focus:not(:focus-visible)`
  suppression rule so mouse/touch users retain the default border.

### `src/styles/focus.css`
- Created a re-export file pointing to `app/styles/focus.css` as specified
  by the PRD path reference.

## Accessibility (WCAG 2.1 AA)
- **2.4.7 Focus Visible**: All interactive form elements now display a clear,
  high-contrast focus ring (`--accent` green, 2px solid) when navigated via
  keyboard. Mouse/touch focus is suppressed to avoid visual noise.
- **Design-token consistency**: Uses `var(--accent)`, `var(--background)`,
  and `var(--border)` — same tokens used across all StreamPay focus rings.
  Works correctly in both dark and light themes.
- **Responsive**: Focus styles are breakpoint-agnostic and render identically
  on mobile, tablet, and desktop viewports.

## Testing

### CSS Layer Tests — `app/styles/focus.css.test.tsx`
- Verifies `.csf-field` is included in focus-visible and suppression selectors.
- Verifies `.create-stream-form .csf-field:focus-visible` rule exists with
  `border-color: var(--accent)`.
- Verifies `.create-stream-form .csf-field:focus:not(:focus-visible)` suppression
  rule exists.

### Component Tests — `app/streams/new/page.focus.test.tsx`
- Verifies the form renders with `create-stream-form` class and `data-testid`.
- Verifies each interactive element (recipient, amount, token, cancel, create)
  carries the `csf-field` class.
- Verifies at least 5 `.csf-field` elements exist within the form.

### Run tests
```bash
npx jest app/styles/focus.css.test.tsx app/streams/new/page.focus.test.tsx
```
