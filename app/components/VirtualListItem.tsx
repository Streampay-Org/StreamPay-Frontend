"use client";

import React, { useRef, useState, useEffect, useImperativeHandle } from "react";

interface VirtualListItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  children: React.ReactNode;
  defaultHeight?: number;
}

export const VirtualListItem = React.forwardRef<HTMLLIElement, VirtualListItemProps>(
  function VirtualListItem(
    { children, defaultHeight = 100, style, ...props },
    externalRef,
  ) {
    const internalRef = useRef<HTMLLIElement>(null);

    // Forward the internal <li> DOM node to callers (both object refs and callback refs),
    // while ensuring internalRef is always attached to <li> even when no ref is forwarded.
    useImperativeHandle(externalRef, () => internalRef.current as HTMLLIElement);

    const [isVisible, setIsVisible] = useState(true);
    const [height, setHeight] = useState(defaultHeight);

    useEffect(() => {
      const el = internalRef.current;
      if (!el) return;

      // Fallback to fully rendered if observers aren't available (e.g. JSDOM tests)
      if (
        typeof IntersectionObserver === "undefined" ||
        typeof ResizeObserver === "undefined"
      ) {
        return;
      }

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.borderBoxSize && entry.borderBoxSize.length > 0) {
            const blockSize = entry.borderBoxSize[0].blockSize;
            setHeight(blockSize || defaultHeight);
          } else if (entry.contentRect) {
            const contentHeight = entry.contentRect.height;
            setHeight(contentHeight || defaultHeight);
          }
        }
      });

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
          } else {
            setIsVisible(false);
            if (el) {
              const measured = el.getBoundingClientRect().height;
              setHeight((prev) => (measured > 0 ? measured : prev || defaultHeight));
            }
          }
        },
        { rootMargin: "400px 0px" },
      );

      // Eagerly measure initial height to avoid jump on first scroll
      const initialHeight = el.getBoundingClientRect().height;
      setHeight(initialHeight || defaultHeight);

      resizeObserver.observe(el);
      observer.observe(el);

      return () => {
        resizeObserver.disconnect();
        observer.disconnect();
      };
    }, [defaultHeight]);

    return (
      <li
        ref={internalRef}
        style={{ ...style, minHeight: isVisible ? undefined : height }}
        {...props}
      >
        {isVisible ? children : null}
      </li>
    );
  },
);
