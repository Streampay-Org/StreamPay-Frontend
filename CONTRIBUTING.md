# Contributing to StreamPay Frontend

Thank you for your interest in contributing. This document captures the
conventions the team relies on when reviewing pull requests.

## Workflow

1. Fork the repository and create a feature branch off `main`.
2. Make focused, atomic commits using
   [Conventional Commits](https://www.conventionalcommits.org/) prefixes
   (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `style:`).
3. Run `npm run lint` and `npm test` before opening a PR.
4. Open a pull request against `main` describing the change and any
   trade-offs.

## Code style

- TypeScript is preferred over plain JavaScript for any new module.
- Public functions and exported types should carry TSDoc/JSDoc comments.
- Avoid `any` in new code unless an external type genuinely demands it.
- Keep components small and prefer composition over deep prop drilling.

For backend-specific guidance — adding routes, repositories, and tests —
see [docs/backend-contributing.md](docs/backend-contributing.md).

## Tests

- Unit tests live next to the module they cover (`foo.ts` + `foo.test.ts`).
- New behavior should ship with at least one happy-path test and one
  failure-path test.
- Avoid coupling tests to private implementation details — prefer
  observable behavior at the module boundary.

## Accessibility

All UI changes should meet WCAG 2.1 AA. Before opening a pull request,
verify keyboard operability, screen-reader labelling, and motion/color
handling for anything you touched, and check the corresponding box in the
PR template's Accessibility section. A few examples from this codebase to
use as reference:

- **Focus management** — interactive elements need a visible
  `:focus-visible` outline and a sane tab order. See
  [docs/createstreamform-focus-visible.md](docs/createstreamform-focus-visible.md)
  and [docs/streamprogress-focus-accessibility.md](docs/streamprogress-focus-accessibility.md).
- **Live regions** — state changes that don't move focus (copy-to-clipboard,
  toasts, filter results) must be announced to screen readers via
  `aria-live`. See [docs/receiptcard-aria-live.md](docs/receiptcard-aria-live.md)
  and [docs/streamtypechip-aria-live.md](docs/streamtypechip-aria-live.md).
- **Reduced motion** — animations and transitions must fall back to a
  static state when `prefers-reduced-motion: reduce` is set. See
  [docs/WALLET_BADGE_REDUCED_MOTION.md](docs/WALLET_BADGE_REDUCED_MOTION.md).
- **Color-only status** — never rely on color alone to convey state; pair
  it with an icon, text, or pattern.

For a worked example of a full accessibility self-check on a feature, see
[design/streams-search-filter/WCAG_SELF_CHECK.md](design/streams-search-filter/WCAG_SELF_CHECK.md).

## Reporting issues

When filing a bug, please include:

- Steps to reproduce.
- Expected vs. actual behavior.
- A minimal repro, where practical.
- Browser/OS and Node version if it is environment-specific.

## Code review

Reviewers look for clarity, correctness, and adherence to the project
conventions above. A passing CI run is required before merge.
