# StreamRow Responsive Breakpoints — v7

**Issue:** [#1032](../issues/1032) — Add responsive breakpoint audit for StreamRow (v7)  
**Campaign:** GrantFox FWC26 — Stellar Wave  
**Component:** `app/components/StreamRow.tsx`  
**Styles:** `app/globals.css` (`.stream-row` responsive rule blocks)  
**Spec:** `docs/FIGMA-BREAKPOINTS-MODAL-SPEC.md`

---

## Summary

This change implements the full named-breakpoint responsive behaviour for
`StreamRow` as specified in the Figma design handoff (`FIGMA-BREAKPOINTS-MODAL-SPEC.md`).
The component renders a stacked single-column card on mobile/tablet viewports and
transitions to a two-column grid at desktop (1024px+), with an inline three-column
variant at ultrawide (1440px+).

No changes were required to `StreamRow.tsx`. All layout work lives in `app/globals.css`.

---

## Breakpoint Table

| Breakpoint | Range | `stream-row` layout | Notes |
|------------|-------|---------------------|-------|
| `mobile` | 0–479px | Single column stack | Default; no media query required |
| `phablet` | 480–767px | Single column + expanded touch targets | 44px min touch target for action button |
| `tablet` | 768–1023px | Single column | Existing compact override at 48rem preserved |
| `desktop` | 1024–1279px | **2-column grid** | Identity/meta side-by-side |
| `wide` | 1280–1439px | 2-column grid + relaxed padding | `padding-inline: var(--space-8)` |
| `ultrawide` | 1440px+ | **3-column grid** | Action button inline; stream-list capped at 72rem |

---

## Layout Details

### Mobile / Phablet / Tablet (default, < 1024px)

```
┌──────────────────────────────────────────────────┐
│  [color stripe]                                  │
│  [avatar] Recipient Name     [Status Badge]      │ ← stream-row__primary
│           Schedule                               │
│                                                  │
│  Rate            Status                          │ ← stream-row__meta (2-col)
│  ≈≈ XLM/mo       Active                         │
│                                                  │
│  ████████████████░░░░░░░░  50% vested           │ ← stream-row__progress
│                                                  │
│  [     Pause     ]                               │ ← stream-row__action-wrap
└──────────────────────────────────────────────────┘
```

### Desktop (1024px–1439px)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  [color stripe]                                                         │
│  [avatar] Recipient Name  [Badge]  │  Rate      Status     Burn-down    │
│           Schedule                 │  ≈≈ XLM    Active     ██░░░ 50%   │
│                                    │                                    │
│  [ Pause ]                         │  ████████████████░░░░  50% vested  │
└─────────────────────────────────────────────────────────────────────────┘
  ←──── stream-row__primary ────────→ ←──── stream-row__meta + progress ──→
   (grid col 1, 1.6fr)                  (grid col 2, 1fr)
```

### Ultrawide (1440px+)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  [avatar] Recipient Name  [Badge]  │  Rate      Status     Burn-down   │ [Pause] │
│           Schedule                 │                                   │         │
│  ─────────────────────────────────────────────────────────────────────────────── │
│  ████████████████████░░░░░░░░  50% vested  (spans full width)                    │
└──────────────────────────────────────────────────────────────────────────────────┘
  col 1 (1.6fr)                         col 2 (1fr)                   col 3 (auto)
```

---

## CSS Grid Template Summary

```css
/* desktop (1024px+) */
.stream-row {
  grid-template-columns: minmax(0, 1.6fr) minmax(16rem, 1fr);
  grid-template-rows: auto auto;
  column-gap: var(--space-8);   /* 2rem */
  row-gap: var(--space-4);      /* 1rem */
}

/* ultrawide (1440px+) */
.stream-row {
  grid-template-columns: minmax(0, 1.6fr) minmax(16rem, 1fr) auto;
  grid-template-rows: auto;     /* single row */
}
```

---

## Accessibility

| Requirement | Implementation |
|-------------|----------------|
| WCAG 2.1 SC 2.5.5 — Touch target 44×44px | `min-height: 2.75rem; min-width: 2.75rem` on action button from 480px+ |
| WCAG 2.1 SC 1.4.8 — Visual presentation (line length) | `max-width: 42ch` on `.stream-row__schedule` at 1440px+; `.stream-list` capped at `72rem` |
| Focus indicator | Inherited from `app/styles/focus.css` — 2px solid `var(--accent)` with 2px offset |
| Colour contrast | All status tokens verified against their backgrounds in dark and light themes |
| Screen reader structure | `<article aria-labelledby>`, `<h2>` for recipient, `<dt>`/`<dd>` for meta — unchanged across breakpoints |
| Decorative elements hidden | `.stream-row__pattern` and `.stream-row__color-stripe` carry `aria-hidden="true"` |

---

## Dark Mode / Light Mode

No new colour values were introduced. All background, border, and text colours in
the responsive additions use existing semantic tokens (`--panel-elevated`, `--border`,
`--muted-light`, etc.) that already carry light-theme overrides in the `.light`
selector block.

---

## Design Token Usage

| CSS property | Token | Value |
|---|---|---|
| `column-gap` (desktop) | `var(--space-8)` | 2rem / 32px |
| `row-gap` / `gap` | `var(--space-4)` | 1rem / 16px |
| `padding-inline` (wide) | `var(--space-8)` | 2rem / 32px |
| `min-height` / `min-width` (touch target) | raw `2.75rem` | 44px (WCAG minimum) |
| `padding-block` (touch button) | `var(--space-3)` | 0.75rem / 12px |
| compact `column-gap` (desktop) | `var(--space-6)` | 1.5rem / 24px |

---

## Files Changed

| File | Change |
|------|--------|
| `app/globals.css` | Added `@media` blocks for phablet (30rem), desktop (64rem), wide (80rem), ultrawide (90rem), and compact desktop override |
| `app/components/StreamRow.test.tsx` | Added `describe("responsive breakpoints audit")` block — 30+ focused tests |
| `docs/uiux/streamrow-responsive-breakpoints-v7.md` | This document |

---

## Testing

Responsive layout tests live in:

```
app/components/StreamRow.test.tsx
  └── describe("responsive breakpoints audit (Issue #1032)")
        ├── BEM structure hooks for CSS grid layout
        ├── WCAG 2.1 touch target compliance (SC 2.5.5)
        ├── semantic structure preserved across all breakpoints
        ├── compact density at desktop+ (breakpoint override hooks)
        ├── ultrawide max-width hook (.stream-list class contract)
        └── schedule line-length clamp (ultrawide readability)
```

Because jsdom does not process stylesheets, tests assert the DOM/BEM structure
that the responsive CSS selectors target. Viewport-specific layout correctness
must be verified in a real browser or via visual regression tools (Playwright /
Chromatic).

Run the StreamRow suite only:

```bash
npx jest app/components/StreamRow.test.tsx
```

---

## Relationship to Existing Docs

| Document | Relationship |
|----------|-------------|
| `docs/FIGMA-BREAKPOINTS-MODAL-SPEC.md` | Source design spec — this implementation fulfils the StreamRow section |
| `docs/ISSUE-75-BREAKPOINTS-SUMMARY.md` | Design review summary for the same spec |
| `docs/uiux/streamrow-design-tokens-v7.md` | v7 spacing token changes (Issue #1030) — this builds on top of those tokens |
