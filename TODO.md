# TODO — Streams dense layout toggle

- [ ] Add density state + toggle UI in `app/streams/StreamsPageContent.tsx` with localStorage persistence (`streampay.density`)
- [ ] Pass density to `app/components/StreamRow.tsx` and apply compact class
- [ ] Add compact CSS rules in `app/globals.css` (reduce padding/gaps for `.stream-row--compact` and related layouts)
- [ ] Update `app/streams/page.test.tsx` to cover:
  - [ ] comfortable mode (default) -> non-compact
  - [ ] compact mode -> compact class
  - [ ] toggle interaction updates localStorage
  - [ ] keyboard accessibility (role="switch" + aria-checked)
- [ ] Run `npm test -- app/streams/page.test.tsx` and ensure passing
- [ ] Commit changes with message: `feat: add dense-mode toggle to streams list`
- [ ] Provide manual visual testing notes for PR

