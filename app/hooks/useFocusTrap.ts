"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface UseFocusTrapOptions {
  /** Whether the trap is engaged. Focus is restored when this turns false. */
  isActive: boolean;
  /** The container that keyboard focus is confined to. */
  containerRef: RefObject<HTMLElement | null>;
  /** Called when Escape is pressed while the trap is active. */
  onEscape?: () => void;
  /** Restore focus to the element focused before activation (default true). */
  restoreFocus?: boolean;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      !element.hasAttribute("hidden") &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Confine keyboard focus to `containerRef` while `isActive` is true.
 *
 * - On activation, remembers the previously focused element and moves focus
 *   into the container (unless focus is already inside it).
 * - Tab / Shift+Tab wrap between the first and last focusable descendants,
 *   and focus that escapes the container is pulled back in.
 * - Escape invokes `onEscape`.
 * - On deactivation (or unmount), focus returns to the remembered element.
 */
export function useFocusTrap({
  isActive,
  containerRef,
  onEscape,
  restoreFocus = true,
}: UseFocusTrapOptions): void {
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!isActive) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!container.contains(document.activeElement)) {
      container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (onEscapeRef.current) {
          event.preventDefault();
          onEscapeRef.current();
        }
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !container.contains(active);

      if (event.shiftKey) {
        if (outside || active === first || active === container) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (outside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !container.contains(target)) {
        const [first] = getFocusableElements(container);
        (first ?? container).focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      if (
        restoreFocus &&
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        previouslyFocused.focus();
      }
    };
  }, [isActive, containerRef, restoreFocus]);
}
