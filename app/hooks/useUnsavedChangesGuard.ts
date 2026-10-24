'use client';

import { useCallback, useEffect, useRef } from 'react';

export type UnsavedChangesConfirmer = (
  origin?: HTMLElement | null
) => Promise<boolean>;

export interface UseUnsavedChangesGuardOptions {
  /** Whether the guarded form currently has unsaved edits. */
  isDirty: boolean;
  /**
   * Asks the user whether navigation should proceed. Resolve `true` to allow
   * navigation, `false` to stay on the current page.
   */
  onConfirm: UnsavedChangesConfirmer;
}

export interface UnsavedChangesGuard {
  /**
   * Explicit guard entry point for in-app navigations such as tab changes.
   * Resolves `true` when navigation may proceed.
   */
  confirmNavigation: UnsavedChangesConfirmer;
}

function getSameOriginAnchor(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }

  const target = event.target;
  if (!(target instanceof Element)) return null;

  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.hasAttribute('download')) return null;
  if (anchor.target && anchor.target !== '_self') return null;

  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return null;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;
  // Leaving the current document is what needs guarding; same-page anchors
  // (e.g. "#section") are handled above.
  if (url.href === window.location.href) return null;

  return anchor;
}

/**
 * Guards unsaved edits against page unload and same-origin link navigation.
 *
 * The hook only attaches listeners while `isDirty` is true, and removes both
 * listeners as soon as the form becomes clean (for example after a save).
 */
export function useUnsavedChangesGuard({
  isDirty,
  onConfirm,
}: UseUnsavedChangesGuardOptions): UnsavedChangesGuard {
  const onConfirmRef = useRef(onConfirm);
  const isDirtyRef = useRef(isDirty);

  useEffect(() => {
    onConfirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  const confirmNavigation = useCallback<UnsavedChangesConfirmer>(
    (origin) =>
      isDirtyRef.current
        ? onConfirmRef.current(origin)
        : Promise.resolve(true),
    []
  );

  useEffect(() => {
    if (!isDirty || typeof window === 'undefined') return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required by older browsers to show the native confirmation prompt.
      event.returnValue = '';
    };

    const handleDocumentClick = (event: MouseEvent) => {
      const anchor = getSameOriginAnchor(event);
      if (!anchor) return;

      // Stop Next.js Link/router handlers from navigating before the user has
      // confirmed. Capture-phase listeners run before React's click handlers.
      event.preventDefault();
      event.stopPropagation();

      void onConfirmRef.current(anchor).then((allowed) => {
        if (allowed) {
          window.location.assign(anchor.href);
        }
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleDocumentClick, true);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, [isDirty]);

  return { confirmNavigation };
}
