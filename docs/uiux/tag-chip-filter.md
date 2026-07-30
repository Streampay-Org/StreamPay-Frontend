# Tag Chip Filter (GrantFox FWC26)

Clicking a tag chip above the streams list filters the list down to streams
carrying that tag. Clicking the active chip again — or the clear ("✕")
chip — resets the list to show every stream.

## API Notes

Client-side only. No backend API contract changes. Tags are read from the
existing `StreamRowData.tags` field (a plain `string[]`); nothing is sent
to the server as a result of selecting a tag.

## Components

- `app/components/TagChips.tsx` — filter bar. Renders one chip per unique
  tag plus a clear chip when a tag is selected. Pre-existing component
  (added in #681); this change is the first to wire it into a page.
- `app/components/StreamRow.tsx` — now accepts an optional `tags?: string[]`
  field on `StreamRowData` and renders each tag as a read-only pill under
  the recipient/schedule text.
- `app/streams/StreamsPageContent.tsx` — derives the unique tag list from
  the current `streams` prop, owns `selectedTag` state, renders `TagChips`
  above the list, and filters the rendered rows by the selected tag. The
  filter bar itself is only rendered when at least one stream has tags.

## Accessibility (WCAG 2.1 AA)

- The chip bar is a `role="group"` with `aria-label="Filter by tag"`.
- Each chip is a native `<button>` with `aria-pressed` reflecting selection
  state, so screen readers announce the current filter.
- The clear chip has an explicit `aria-label="Clear tag filter"`.
- All chips are keyboard operable (native buttons) and use the shared
  `:focus-visible` outline token.
- The "no streams match this tag" message is exposed via `role="status"`
  so assistive tech announces the filtered-to-empty state.

## Design tokens / dark mode

Chip styling (`.tag-chips`, `.tag-chip`, `.tag-chip--active`,
`.tag-chip--clear`) and row tag pills (`.tag-pill`) in `app/globals.css`
use existing semantic tokens (`--panel`, `--border`, `--foreground`,
`--accent`, `--accent-on`, `--muted-light`) so both themes stay consistent
without new hardcoded colors.

## Responsive behavior

The chip bar is a `flex-wrap` row, so it wraps naturally at narrow
viewports instead of overflowing or requiring horizontal scroll.

## Tests

- `app/components/TagChips.test.tsx` — chip rendering, selection,
  deselection, clear button, `aria-pressed` state, empty-tags no-render.
- `app/streams/page.test.tsx` (`tag chip filtering` block) — filter bar
  hidden when no stream has tags, filtering the list on chip click, and
  toggling a chip back off restores the full list.
