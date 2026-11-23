"use client";

import { useEffect } from "react";

export default function EmbedResize() {
  useEffect(() => {
    if (window.parent === window) return;

    let lastHeight = 0;

    const reportHeight = () => {
      const height = Math.ceil(
        document.documentElement.scrollHeight,
      );

      if (height === lastHeight) return;

      lastHeight = height;

      window.parent.postMessage(
        {
          type: "streampay:resize",
          height,
        },
        "*",
      );
    };

    const observer = new ResizeObserver(reportHeight);

    observer.observe(document.documentElement);
    reportHeight();

    return () => observer.disconnect();
  }, []);

  return null;
}