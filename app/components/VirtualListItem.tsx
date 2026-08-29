"use client";

import React, { useRef, useState, useEffect } from "react";

interface VirtualListItemProps extends React.LiHTMLAttributes<HTMLLIElement> {
  children: React.ReactNode;
  defaultHeight?: number;
}

export function VirtualListItem({
  children,
  defaultHeight = 100,
  style,
  ...props
}: VirtualListItemProps) {
  const ref = useRef<HTMLLIElement>(null);
  const [isVisible, setIsVisible] = useState(true);
  const [height, setHeight] = useState(defaultHeight);

  useEffect(() => {
    const el = ref.current;
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
          setHeight(entry.borderBoxSize[0].blockSize);
        } else {
          setHeight(entry.contentRect.height);
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
            setHeight(el.getBoundingClientRect().height);
          }
        }
      },
      { rootMargin: "400px 0px" },
    );

    // Eagerly measure initial height to avoid jump on first scroll
    setHeight(el.getBoundingClientRect().height || defaultHeight);

    resizeObserver.observe(el);
    observer.observe(el);

    return () => {
      resizeObserver.disconnect();
      observer.disconnect();
    };
  }, [defaultHeight]);

  return (
    <li
      ref={ref}
      style={{ ...style, minHeight: isVisible ? undefined : height }}
      {...props}
    >
      {isVisible ? children : null}
    </li>
  );
}
