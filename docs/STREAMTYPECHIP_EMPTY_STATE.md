# StreamTypeChip Empty State (v7)

**Issue:** [#1085](https://github.com/Streampay-Org/StreamPay-Frontend/issues/1085) Add empty-state illustration for StreamTypeChip (v7)  
**Campaign:** GrantFox FWC26 Campaign (Stellar Wave)  

---

## Overview

When no stream type is available, `StreamTypeChip` renders a themed empty state with illustration and a helpful CTA instead of an empty chip.

## Behaviour

| Condition | Result |
| --------- | ------ |
| `isEmpty={true}` | Empty state |
| `type` missing / blank / whitespace | Empty state |
| Valid `type` string | Normal chip |

Default empty copy:

- **Title:** No stream type selected  
- **Description:** Pick a stream type to see amount details, or create a new stream to get started.  
- **CTA:** Create a stream  

## API changes

### `StreamTypeChip` (`app/StreamTypeChip.tsx`)

New optional props (backward compatible — existing `type` + `amount` usage unchanged):

- `isEmpty?: boolean`
- `emptyTitle?: string`
- `emptyDescription?: string`
- `emptyCtaText?: string`
- `onEmptyCtaClick?: () => void`
- `className?: string`
- `type` / `amount` are now optional when empty

### `EmptyState` (`src/components/EmptyState.tsx`)

- New `variant?: "default" | "stream-type-chip"` — chip variant uses tighter padding/`max-width`
- CTA renders whenever `ctaText` is set; disabled when `onCtaClick` is omitted

## Verification

```bash
npx jest app/StreamTypeChip.test.tsx src/components/EmptyState.test.tsx --no-coverage
```
