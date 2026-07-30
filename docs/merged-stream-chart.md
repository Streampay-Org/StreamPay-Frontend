# MergedStreamChart component

Summary

- Purpose: Visualise multiple payment streams in a single, merged progress view. Shows aggregate progress and per-stream breakdown.

Props

- `streams: StreamData[]` — Array of stream objects with fields: `id`, `status`, `accruedAmount?`, `totalAmount?`, `startedAt?`, `endsAt?`, `name?`.
- `className?: string` — Optional class name forwarded to the wrapper.

Accessibility

- Uses `role="region"` with descriptive `aria-label` for the chart container.
- Delegates per-stream progress to `StreamProgress`, which exposes `role="progressbar"` and `aria-valuetext`.
- Empty state announces via `aria-live="polite"`.

Notes

- Responsive and styling follow existing `StreamProgress` tokens and BEM modifiers.
- No network/API changes. This is a UI-only component.

Usage

Import and render:

```tsx
import { MergedStreamChart } from '@/app/components/MergedStreamChart';

<MergedStreamChart streams={[ /* ... */ ]} />
```

Tests

- `app/components/MergedStreamChart.test.tsx` covers empty state, aggregation math, and aggregated status derivation.

