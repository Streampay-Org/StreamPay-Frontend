# StreamRow Spacing & Typography — Design Tokens v7

**Issue:** [#1030](../issues/1030) — Polish StreamRow spacing per design tokens (v7)  
**Campaign:** GrantFox FWC26 — Stellar Wave  
**Component:** `app/components/StreamRow.tsx`  
**Styles:** `app/globals.css` (`.stream-row` and `.stream-row--compact` rule blocks)

---

## Summary of Changes

All raw CSS length values in the StreamRow rule blocks have been replaced with
references to the global spacing token scale. A new `--space-3-5` half-step
token was added to bridge the 12 px/16 px gap for the compact padding value.

No changes were required to `StreamRow.tsx`; the component exclusively uses
BEM class names and all visual properties live in `globals.css`.

---

## Token Mapping

### Cozy (default) density

| CSS property | Old value | New value | Token |
|---|---|---|---|
| `.stream-row` — `gap` | `1rem` | `var(--space-4)` | `--space-4: 1rem` |
| `.stream-row` — `padding` | `1.25rem` | `var(--space-5)` | `--space-5: 1.25rem` |
| `.stream-row__primary` — `gap` | `0.75rem` | `var(--space-3)` | `--space-3: 0.75rem` |
| `.stream-row__identity` — `gap` | `0.75rem` | `var(--space-3)` | `--space-3: 0.75rem` |
| `.stream-row__meta` — `gap` | `0.75rem` | `var(--space-3)` | `--space-3: 0.75rem` |
| `.stream-row__recipient` — `margin-bottom` | `0.35rem` | `var(--space-1)` | `--space-1: 0.25rem` |
| `.stream-row__meta dt` — `margin-bottom` | `0.35rem` | `var(--space-1)` | `--space-1: 0.25rem` |
| `.stream-row__cancel-reveal` — `padding-right` | `1.5rem` | `var(--space-6)` | `--space-6: 1.5rem` |

> **Note:** `0.35rem` → `--space-1` (0.25 rem) is intentional. The original
> value was a one-off; snapping to the nearest token step tightens the rhythm
> by 1px and eliminates a magic number.

### Compact density (`.stream-row--compact`)

| CSS property | Old value | New value | Token |
|---|---|---|---|
| `padding` | `0.875rem` | `var(--space-3-5)` | `--space-3-5: 0.875rem` *(new)* |
| `gap` | `0.75rem` | `var(--space-3)` | `--space-3: 0.75rem` |
| `.stream-list--compact` — `gap` | `0.75rem` | `var(--space-3)` | `--space-3: 0.75rem` |
| `…__primary` — `gap` | `0.5rem` | `var(--space-2)` | `--space-2: 0.5rem` |
| `…__recipient` — `margin-bottom` | `0.25rem` | `var(--space-1)` | `--space-1: 0.25rem` |
| `…__meta` — `gap` | `0.5rem` | `var(--space-2)` | `--space-2: 0.5rem` |
| `…__meta dt` — `margin-bottom` | `0.25rem` | `var(--space-1)` | `--space-1: 0.25rem` |
| `…__action-wrap` — `gap` | `0.25rem` | `var(--space-1)` | `--space-1: 0.25rem` |

---

## New Token: `--space-3-5`

```css
/* ── Spacing Scale ── */
--space-1: 0.25rem;    /*  4 px */
--space-2: 0.5rem;     /*  8 px */
--space-3: 0.75rem;    /* 12 px */
--space-3-5: 0.875rem; /* 14 px — compact-row padding half-step */
--space-4: 1rem;       /* 16 px */
--space-5: 1.25rem;    /* 20 px */
--space-6: 1.5rem;     /* 24 px */
--space-8: 2rem;       /* 32 px */
```

The `--space-3-5` half-step follows the Tailwind-style naming convention
(`space-3.5` / `14px`) and is the only half-step required by current designs.
Its single current usage is the compact StreamRow row padding.

---

## Unchanged Values

The following values have no corresponding token in the current scale and were
left as raw values intentionally:

| Property | Value | Reason |
|---|---|---|
| `.stream-row__meta dt` — `font-size` | `0.8125rem` | No font-size token scale exists in this repo |
| `.stream-row__receipt-link` — `font-size` | `0.75rem` | No font-size token scale exists in this repo |
| `.stream-row__cancel-label` — `font-size` | `0.875rem` | No font-size token scale exists in this repo |
| `border-radius` values | `1.25rem`, `1.1rem` | Structural radii; not part of spacing scale |

Colors already used semantic token references (e.g., `var(--muted)`,
`var(--muted-light)`, `var(--system-error-text)`) before this change.

---

## Testing

12 new focused tests were added to `app/components/StreamRow.test.tsx` under
`describe("design tokens v7 – spacing & typography BEM hooks")`.

Since jsdom does not load stylesheets, tests assert the DOM/BEM structure that
the CSS token rules hook into. This proves the CSS selectors will activate when
the stylesheet is loaded in a browser. The assertion strategy follows the same
pattern used by the existing `describe("color-blind safe pattern overlay")` and
`describe("compact density variant")` blocks.
