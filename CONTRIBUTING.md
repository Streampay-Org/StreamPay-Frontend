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

## Tests

- Unit tests live next to the module they cover (`foo.ts` + `foo.test.ts`).
- New behavior should ship with at least one happy-path test and one
  failure-path test.
- Avoid coupling tests to private implementation details — prefer
  observable behavior at the module boundary.

### Test environment layout

The project uses **two Jest environments** configured via a `projects` array in
`jest.config.js`. Understanding which environment a test file runs in is
important for both writing tests and debugging unexpected failures.

| File pattern | Jest project | Environment | Typical use |
|---|---|---|---|
| `**/*.test.ts`, `**/*.spec.ts` | `node` | Node.js | API routes, lib utilities, pure-logic unit tests |
| `**/*.test.tsx`, `**/*.spec.tsx` | `jsdom` | `jest-environment-jsdom` | React component tests (render, interaction, accessibility) |

The split exists because:
- Node.js is faster and avoids browser polyfills for pure logic.
- React components require a DOM — `jsdom` provides `document`, `window`,
  and the browser APIs that `@testing-library/react` depends on.

#### Writing component tests

Component test files **must** use the `.test.tsx` extension so Jest picks the
`jsdom` project automatically. You do not need a `@jest-environment` docblock.

```tsx
// app/components/MyWidget.test.tsx  ← .tsx extension → jsdom environment
import { render, screen } from "@testing-library/react";
import { MyWidget } from "./MyWidget";

it("renders the widget label", () => {
  render(<MyWidget label="Hello" />);
  expect(screen.getByText("Hello")).toBeInTheDocument();
});
```

#### Writing Node/API tests

Plain `.test.ts` files run in the Node environment and must **not** import
React or `@testing-library/react`. Keep DOM-free assertions in `.test.ts` and
render/interaction assertions in `.test.tsx`.

#### Running tests

```bash
# Full suite (both projects)
npm test

# Watch mode
npm test -- --watch

# Single file
npm test -- app/components/Modal.test.tsx

# Coverage
npm test -- --coverage
```

See `jest.config.js` and `jest.setup.ts` for the full runtime configuration,
and `docs/testing-guide.md` for more conventions.

## Component API documentation

All exported component props interfaces and types must carry TSDoc comments so
that editors can surface them inline. The minimal required annotations are:

- A one-line description on the `interface` / `type` itself.
- A `/** … */` comment on every prop that is not self-evident from its name
  and type alone (especially optional props and union types).

Example:

```tsx
/** Props for the {@link Card} component. */
interface CardProps {
  /** Inner padding size. Defaults to `"md"` (1 rem). */
  padding?: "none" | "sm" | "md" | "lg";
  /** When provided the card becomes interactive. */
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}
```

## Reporting issues

When filing a bug, please include:

- Steps to reproduce.
- Expected vs. actual behavior.
- A minimal repro, where practical.
- Browser/OS and Node version if it is environment-specific.

## Code review

Reviewers look for clarity, correctness, and adherence to the project
conventions above. A passing CI run is required before merge.
