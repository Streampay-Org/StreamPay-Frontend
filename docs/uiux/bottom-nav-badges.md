# Bottom Nav with Badges

## Issue

- `#861` Add mobile bottom nav with badges

## Visible Changes

- Mobile-only fixed bottom navigation bar added to the app layout.
- Navigation items: Streams, Activity, Settings.
- Each item can display an icon, label, and an unread badge count.
- Badges cap visually at `maxBadgeCount` (default `9`) and render as `N+`.
- Active route is highlighted with the accent color and `aria-current="page"`.
- Home page (`/`) does not show the bottom nav.

## Components Added

- `app/components/BottomNav.tsx`
- `app/components/AppBottomNav.tsx`

## Routes Updated

- `app/layout.tsx`

## Accessibility

- `aria-current="page"` on the active link.
- `sr-only` text announces exact pending counts to screen readers.
- `focus-visible` outlines on badges and links.
- Safe-area inset padding for notched devices.
- Respects `prefers-reduced-motion`.

## Design Tokens

Uses existing tokens:

- `--accent` / `--accent-on`
- `--panel`
- `--border`
- `--muted`
- `--foreground`

## API / Backend Notes

No backend API changes required. Badge counts are supplied via component props:

```ts
type BottomNavItem = {
  href: string;
  label: string;
  icon?: React.ReactNode;
  badgeCount?: number;
};
```

If unread counts are later fetched from an API, the `AppBottomNav` component should consume that data and pass it through the existing `badgeCount` prop. No route or layout signature changes are needed.

## Tests

- `app/components/BottomNav.test.tsx` — covers active route, badge rendering, capping, aria text, and icons.
- `app/components/AppBottomNav.test.tsx` — covers home-page visibility and app-page visibility.

## Verification

Standard verification:

```bash
npm test -- --testPathPattern="(BottomNav|AppBottomNav)"
npm run lint -- --max-warnings=0
```
