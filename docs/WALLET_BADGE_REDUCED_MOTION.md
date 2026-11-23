# WalletBadge Reduced-Motion Fallback (v7)

**Issue:** [#1078](https://github.com/Streampay-Org/StreamPay-Frontend/issues/1078) Add reduced-motion fallback for WalletBadge (v7)  
**Campaign:** GrantFox FWC26 Campaign (Stellar Wave)  
**Status:** Completed & Verified  

---

## Overview

`WalletBadge` animates status-dot pulse during `connecting` / `disconnecting` and uses CSS transitions for background, border, and hover states. When the user has `prefers-reduced-motion: reduce`, those motions are replaced with a **static fallback** so the badge remains readable without motion.

## Behaviour

| Preference | Badge attribute | Transitions | Connecting/disconnecting pulse |
| ---------- | --------------- | ----------- | ------------------------------ |
| Default (`no-preference`) | `data-reduced-motion="false"` | Enabled (200ms) | CSS `wallet-badge-pulse` keyframes |
| `prefers-reduced-motion: reduce` | `data-reduced-motion="true"` | `transition: none` | `animation: none` (static opacity/scale) |

Implementation layers:

1. **JS hook** `usePrefersReducedMotion` in `app/WalletBadge.tsx` — sets `data-reduced-motion`, inline `transition` / `animation`, and `.badgeStatic` / `.badgeAnimated` modifiers.
2. **CSS media query** in `app/WalletBadge.module.css` — belt-and-suspenders `@media (prefers-reduced-motion: reduce)` disables transitions and pulse even if JS has not hydrated yet.

## API Compatibility

No props were added or changed. Existing `WalletBadgeProps` remain backward compatible.

## Verification

```bash
npx jest app/WalletBadge.test.tsx
```

Focused coverage:

- Animated path when reduced motion is **not** requested
- Static fallback (`transition` / `animation` none) when reduced motion **is** requested
- Status content and live-region announcements remain available either way
