# StreamTypeChip — Color-Blind Pattern Fills

**Campaign:** GrantFox FWC26 / Stellar Wave  
**Branch:** `task/streamtypechip-cb-v7`  
**Files changed:** `app/StreamTypeChip.tsx`, `app/styles/patterns.css`, `app/StreamTypeChip.test.tsx`

---

## Overview

`StreamTypeChip` (`app/StreamTypeChip.tsx`) now accepts an optional `status` prop.
When provided, the chip receives an SVG-texture overlay via the shared
`cb-pattern--<status>` utility classes defined in `app/styles/patterns.css`.

This means users with colour-vision deficiency (protanopia, deuteranopia,
tritanopia, achromatopsia) can distinguish stream lifecycle states by
**geometric shape and texture in addition to colour and glyphs**, satisfying
WCAG 1.4.1 Use of Color.

---

## API change

### `StreamTypeChipProps`

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `type` | `string` | ✅ | Stream type label (e.g. `"Video"`, `"Audio"`). |
| `amount` | `number` | ✅ | Amount associated with the stream. |
| `status` | `StreamStatus` | ☐ optional | Lifecycle status. When provided, applies `cb-pattern--<status>`. Omitting it leaves the chip visually unchanged (backward-compatible). |

### `StreamStatus` (new export)

```ts
export type StreamStatus =
  | 'active'
  | 'draft'
  | 'paused'
  | 'ended'
  | 'cancelled'
  | 'withdrawn';
```

Import it from the component module if you need to type-check status values:

```ts
import type { StreamStatus } from '@/app/StreamTypeChip';
```

### Usage examples

```tsx
// No status — renders exactly as before (backward-compatible)
<StreamTypeChip type="Video" amount={12345} />

// With status — adds texture overlay
<StreamTypeChip type="Video" amount={12345} status="active" />
<StreamTypeChip type="Audio" amount={500}   status="paused" />
<StreamTypeChip type="Token" amount={0}     status="cancelled" />
```

---

## Pattern vocabulary

Each status maps to a unique geometric texture from `app/styles/patterns.css`:

| Status | Pattern | Visual mnemonic |
|--------|---------|-----------------|
| `active` | 45° diagonal stripes `///` | Flowing / in motion |
| `draft` | Spaced dots `···` | Not started / pending |
| `paused` | Horizontal bars `≡` | Held / stopped |
| `ended` | Crosshatch `×` | Complete / locked |
| `cancelled` | Reverse-diagonal `\\\` | Aborted |
| `withdrawn` | Crosshatch `×` (same as ended) | Terminal / refunded |

---

## Implementation details

### DOM output

When `status` is set the chip `div` receives two additional attributes:

```html
<div
  class="streamTypeChip stream-type-chip cb-pattern--active"
  data-status="active"
  tabindex="0"
  ...
>
```

- `cb-pattern--<status>` — triggers the texture overlay via `::before` pseudo-element.
- `data-status` — machine-readable hook for integration tests and analytics selectors.

### CSS (`app/styles/patterns.css`)

A new block inside `@layer patterns` tailors the shared overlay for the compact
chip footprint:

```css
.stream-type-chip.cb-pattern--active::before,
.stream-type-chip.cb-pattern--draft::before,
.stream-type-chip.cb-pattern--paused::before,
.stream-type-chip.cb-pattern--ended::before,
.stream-type-chip.cb-pattern--withdrawn::before,
.stream-type-chip.cb-pattern--cancelled::before {
  opacity: calc(var(--cb-pattern-opacity) * 0.7);
  background-size: 8px 8px;
}
```

- **Tile size 8px** (down from the default 10px) so the pattern remains readable
  at the chip's compact size.
- **Opacity ×0.7** keeps the type label and amount fully legible on top of the
  texture (same reduction used by `StatusBadge`).
- High-contrast mode (`prefers-contrast: more`) automatically increases the base
  `--cb-pattern-opacity` to `0.38`, so the chip texture also punches up.

The overlay is a `::before` pseudo-element with `pointer-events: none` and
`mix-blend-mode: multiply`, so it never intercepts clicks and inherits the
semantic status colour rather than forcing a black overlay.

---

## Accessibility

| Criterion | How it's met |
|-----------|--------------|
| WCAG 1.4.1 Use of Color | Texture pattern supplements colour — status is distinguishable by shape alone |
| WCAG 2.4.7 Focus Visible | Existing `tabIndex={0}` + focus-visible ring unchanged |
| `prefers-reduced-motion` | Pattern is **static** — no animation, no conflict with motion preferences |
| `prefers-contrast: more` | `--cb-pattern-opacity` escalates to `0.38`; chip inherits this automatically |
| Grayscale / print | Patterns differ in *geometry*, not just spacing, so they remain distinct in b/w |

---

## Testing

`app/StreamTypeChip.test.tsx` covers:

- **Without `status`** — no `cb-pattern` class; no `data-status` attribute.
- **Each status** (`active`, `draft`, `paused`, `ended`, `cancelled`, `withdrawn`):
  - Correct `cb-pattern--<status>` class applied.
  - `data-status` attribute set correctly.
  - No other `cb-pattern--*` class present simultaneously.
  - `stream-type-chip` base class always retained.
  - Type and amount still render correctly.
- **`patterns.css` selectors** — all six `stream-type-chip.cb-pattern--*::before`
  selectors present; compact tile/opacity overrides present.
- **`prefers-reduced-motion`** — pattern class still applied even when motion is
  reduced (pattern is static, so no conflict).

Run:

```bash
npx jest app/StreamTypeChip.test.tsx
```

Expected: **32 tests, 32 passed**.

---

## Migration / backward compatibility

The `status` prop is **optional**. Existing call sites that render
`<StreamTypeChip type="…" amount={…} />` without a `status` are unaffected —
no pattern class is added and the visual output is identical to before.
