"use client";

import { useState, useEffect, useCallback } from "react";

export type Density = "cozy" | "compact";

const DENSITY_KEY = "streampay-density";

function readDensity(): Density {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const stored = window.localStorage.getItem(DENSITY_KEY);
      if (stored === "cozy" || stored === "compact") return stored;
    }
  } catch {
    // localStorage unavailable
  }
  return "cozy";
}

function writeDensity(density: Density): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(DENSITY_KEY, density);
    }
  } catch {
    // localStorage full or unavailable
  }
}

type DensityToggleProps = {
  value?: Density;
  onChange?: (density: Density) => void;
};

export function DensityToggle({ value, onChange }: DensityToggleProps) {
  const [internal, setInternal] = useState<Density>("cozy");
  const density = value ?? internal;

  useEffect(() => {
    setInternal(readDensity());
  }, []);

  const handleChange = useCallback(
    (next: Density) => {
      if (next === density) return;
      setInternal(next);
      writeDensity(next);
      onChange?.(next);
    },
    [density, onChange],
  );

  return (
    <div
      className="density-toggle"
      role="radiogroup"
      aria-label="List density"
    >
      <span className="density-toggle__label">View</span>
      <button
        role="radio"
        aria-checked={density === "cozy"}
        className={`density-toggle__option ${density === "cozy" ? "density-toggle__option--active" : ""}`}
        onClick={() => handleChange("cozy")}
        type="button"
      >
        Cozy
      </button>
      <button
        role="radio"
        aria-checked={density === "compact"}
        className={`density-toggle__option ${density === "compact" ? "density-toggle__option--active" : ""}`}
        onClick={() => handleChange("compact")}
        type="button"
      >
        Compact
      </button>
    </div>
  );
}

export { readDensity, writeDensity };
