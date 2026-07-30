"use client";

import React, {
  KeyboardEvent,
  MouseEvent,
  PropsWithChildren,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  reducedMotion?: boolean;
}

export const BottomSheet: React.FC<PropsWithChildren<BottomSheetProps>> = ({
  isOpen,
  onClose,
  title,
  reducedMotion = false,
  children,
}) => {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const pointerDownOnOverlayRef = useRef(false);
  const titleId = useId();

  useEffect(() => {
    if (isOpen) setShouldRender(true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      previouslyFocusedElementRef.current = document.activeElement as HTMLElement | null;
      containerRef.current?.focus();
      return;
    }

    previouslyFocusedElementRef.current?.focus();
    previouslyFocusedElementRef.current = null;
  }, [isOpen]);

  const handleAnimationEnd = () => {
    if (!isOpen) setShouldRender(false);
  };

  const handleOverlayPointerDown = (event: MouseEvent<HTMLDivElement>) => {
    pointerDownOnOverlayRef.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    const startedOnOverlay = pointerDownOnOverlayRef.current;
    pointerDownOnOverlayRef.current = false;
    if (startedOnOverlay && event.target === event.currentTarget) {
      onClose();
    }
  };

  const getFocusableElements = () => {
    if (!containerRef.current) return [];

    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(
        [
          "a[href]",
          "button:not([disabled])",
          "textarea:not([disabled])",
          "input:not([disabled])",
          "select:not([disabled])",
          "[tabindex]:not([tabindex='-1'])",
        ].join(",")
      )
    ).filter(
      (element) =>
        !element.hasAttribute("hidden") &&
        element.getAttribute("aria-hidden") !== "true"
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements = getFocusableElements();

    if (focusableElements.length === 0) {
      event.preventDefault();
      containerRef.current?.focus();
      return;
    }

    const firstFocusableElement = focusableElements[0];
    const lastFocusableElement = focusableElements[focusableElements.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey) {
      if (
        activeElement === firstFocusableElement ||
        !containerRef.current?.contains(activeElement)
      ) {
        event.preventDefault();
        lastFocusableElement.focus();
      }
      return;
    }

    if (
      activeElement === lastFocusableElement ||
      !containerRef.current?.contains(activeElement)
    ) {
      event.preventDefault();
      firstFocusableElement.focus();
    }
  };

  if (!shouldRender) return null;

  return (
    <div
      data-testid="bottom-sheet-overlay"
      onMouseDown={handleOverlayPointerDown}
      onClick={handleOverlayClick}
      onAnimationEnd={handleAnimationEnd}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 1000,
        ...(reducedMotion
          ? { opacity: isOpen ? 1 : 0 }
          : { animation: `${isOpen ? "sheetFadeIn" : "sheetFadeOut"} var(--motion-duration-medium, 200ms) var(--motion-easing, cubic-bezier(0.16, 1, 0.3, 1)) forwards` }),
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          width: "100%",
          maxHeight: "90vh",
          backgroundColor: "var(--panel-elevated)",
          borderTop: "1px solid var(--border)",
          borderRadius: "1.5rem 1.5rem 0 0",
          padding: "1.5rem 1.5rem calc(2rem + env(safe-area-inset-bottom)) 1.5rem",
          boxShadow: "0 -10px 25px rgba(0, 0, 0, 0.4)",
          overflowY: "auto",
          ...(reducedMotion
            ? { transform: isOpen ? "translateY(0)" : "translateY(100%)" }
            : { animation: `${isOpen ? "sheetSlideUp" : "sheetSlideDown"} var(--motion-duration-medium, 200ms) var(--motion-easing, cubic-bezier(0.16, 1, 0.3, 1)) forwards` }),
        }}
      >
        {/* Grab Handle */}
        <div
          style={{
            width: "40px",
            height: "4px",
            backgroundColor: "var(--border)",
            borderRadius: "2px",
            margin: "0 auto 1.5rem auto",
          }}
          aria-hidden="true"
        />

        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1.5rem",
          }}
        >
          <h2 id={titleId} style={{ fontSize: "1.25rem", margin: 0, fontWeight: 700 }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close bottom sheet"
            style={{
              background: "none",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              fontSize: "1.5rem",
              width: "44px",
              height: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </header>

        {children}
      </div>

      <style jsx global>{`
        @keyframes sheetFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes sheetFadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes sheetSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes sheetSlideDown {
          from { transform: translateY(0); }
          to { transform: translateY(100%); }
        }
      `}</style>
    </div>
  );
};
