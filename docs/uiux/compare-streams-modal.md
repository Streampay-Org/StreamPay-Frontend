# Compare Streams Modal

## Overview

The `CompareStreamsModal` component provides a side-by-side comparison view for two payment streams, allowing users to quickly compare key metrics like rate, runway, balance, and status.

## Component Location

- **File**: `app/components/CompareStreamsModal.tsx`
- **Tests**: `app/components/CompareStreamsModal.test.tsx`

## API

### Props

```typescript
export interface CompareStreamsModalProps {
  /** Controls visibility of the modal */
  isOpen: boolean;
  /** Called when the user dismisses the modal */
  onClose: () => void;
  /** The first stream to compare */
  streamA: CompareStream;
  /** The second stream to compare */
  streamB: CompareStream;
}
```

### CompareStream Interface

```typescript
export interface CompareStream {
  /** Unique stream identifier shown in the header */
  id: string;
  /** Display name of the recipient */
  recipient: string;
  /** Human-readable rate string, e.g. "120 XLM / month" */
  rate: string;
  /** Human-readable runway string, e.g. "14 days remaining" */
  runway: string;
  /** Human-readable current balance, e.g. "340 XLM available" */
  balance: string;
  /** Lifecycle status used to render the colour-coded badge */
  status: StreamStatus;
  /** ISO-8601 creation timestamp */
  createdAt: string;
}
```

## Usage Example

```tsx
import { CompareStreamsModal } from "@/app/components/CompareStreamsModal";

function StreamComparison() {
  const [isOpen, setIsOpen] = useState(false);
  
  const streamA = {
    id: "stream-123",
    recipient: "Alice Johnson",
    rate: "120 XLM / month",
    runway: "14 days remaining",
    balance: "340 XLM available",
    status: "active",
    createdAt: "2024-01-15T10:30:00Z",
  };

  const streamB = {
    id: "stream-456",
    recipient: "Bob Smith",
    rate: "80 XLM / month",
    runway: "21 days remaining",
    balance: "520 XLM available",
    status: "paused",
    createdAt: "2024-02-20T14:45:00Z",
  };

  return (
    <>
      <button onClick={() => setIsOpen(true)}>Compare Streams</button>
      <CompareStreamsModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        streamA={streamA}
        streamB={streamB}
      />
    </>
  );
}
```

## Features

### Accessibility (WCAG 2.1 AA)

- **Role**: `dialog` with `aria-modal="true"` and `aria-labelledby`
- **Focus Management**: 
  - Focus is trapped inside the modal while open (Tab/Shift+Tab cycle)
  - Initial focus lands on the close button
  - Escape key closes the modal
- **Keyboard Navigation**:
  - `Escape` closes the modal
  - `Tab`/`Shift+Tab` cycles through focusable elements
- **Click Behavior**: Backdrop click closes the modal
- **Reduced Motion**: All animations respect `prefers-reduced-motion`
- **Touch Targets**: All interactive elements meet the 44×44px minimum

### Design Tokens

The component uses only CSS custom properties defined in `globals.css`:
- `--card-surface` / `--panel-elevated` for background
- `--border` for borders
- `--foreground` for text
- `--muted` for secondary text
- `--accent` for highlighted values
- `--font-bold`, `--font-semibold` for typography
- `--text-xs`, `--text-base`, `--text-xl` for font sizes
- `--radius-md` for border radius
- `--touch-target` for minimum touch target size

This ensures dark-mode consistency and theme inheritance.

### Responsive Design

- **Mobile (< 640px)**: Single-column stacked layout
- **Desktop (≥ 640px)**: Two-column side-by-side layout

### Comparison Rows

The modal displays the following comparison rows:

1. **Rate** (highlighted with green background)
2. **Runway**
3. **Balance**
4. **Status** (with color-coded badges)
5. **Created** (formatted date)

### Animations

- **Fade in/out**: Backdrop opacity transition (200ms)
- **Scale in/out**: Modal scale and translate transition (200ms)
- **Reduced motion**: Simplified to fade-only when motion is reduced

## Dependencies

- **React**: Hooks (`useCallback`, `useEffect`, `useId`, `useRef`, `useState`)
- **StatusBadge**: Component for rendering stream status badges
- **StreamStatus**: Type from `@/app/types/openapi`

## Testing

The component has comprehensive test coverage in `CompareStreamsModal.test.tsx`:

- **Rendering tests**: Modal visibility, content display
- **Interaction tests**: Close button, backdrop click, Escape key
- **Accessibility tests**: ARIA attributes, focus management
- **Edge cases**: Missing dates, empty strings, different statuses
- **Animation tests**: Unmount behavior after close

Run tests with:
```bash
npm test -- app/components/CompareStreamsModal.test.tsx
```

## Integration Notes

### Status Badge Integration

The component uses the existing `StatusBadge` component to display stream statuses. The status types supported are:
- `active`
- `draft`
- `ended`
- `paused`
- `cancelled`
- `withdrawn`

### Date Formatting

Creation dates are formatted using `toLocaleDateString` with:
- Year: numeric
- Month: short
- Day: numeric

Missing or empty dates display as "—".

### Focus Trap Implementation

The component includes a custom focus trap helper that:
- Identifies all focusable elements within the modal
- Cycles focus to the first element when Tab is pressed on the last element
- Cycles focus to the last element when Shift+Tab is pressed on the first element

## Security Considerations

- No XSS vulnerabilities: All user-provided data is rendered as text content
- No sensitive data exposure: Only display data (rate, balance, etc.) is shown
- Safe event handling: Keyboard events are properly validated

## Performance

- **Mount/Unmount**: Uses `useState` with timeout to allow fade-out animation
- **Focus Management**: Deferred focus with `setTimeout` to ensure DOM is ready
- **Re-renders**: Minimal re-renders due to stable callback references

## Browser Compatibility

- Modern browsers with ES6+ support
- Requires CSS custom properties (CSS variables)
- Requires CSS Grid for layout
- Requires `dialog` role support (all modern browsers)

## Future Enhancements

Potential improvements for future iterations:
- Add stream preview thumbnails
- Include historical data comparison
- Add export comparison as PDF/image
- Support for comparing more than 2 streams
- Add visual charts for rate/balance comparison
