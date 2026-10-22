'use client';

import { useEffect } from 'react';
import { applyTheme } from '../utils/theme-noflash';

const THEME_STORAGE_KEY = 'streampay-theme';
const DYNAMIC_META_ATTR = 'data-dynamic-theme-color';

let listenerCount = 0;
let mediaQueryList: MediaQueryList | null = null;
let handleMediaChange: ((e: MediaQueryListEvent) => void) | null = null;
let handleStorageChange: ((e: StorageEvent) => void) | null = null;

function updateThemeColorMeta(storedTheme: string | null) {
  if (typeof document === 'undefined') return;

  const existingMeta =
    document.querySelector(`meta[${DYNAMIC_META_ATTR}="true"]`) ||
    document.querySelector('meta[name="theme-color"]:not([media])');

  if (storedTheme === 'light' || storedTheme === 'dark') {
    const color = storedTheme === 'light' ? '#ffffff' : '#0a0a0f';
    if (existingMeta) {
      existingMeta.setAttribute('content', color);
      existingMeta.setAttribute(DYNAMIC_META_ATTR, 'true');
    } else {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = color;
      meta.setAttribute(DYNAMIC_META_ATTR, 'true');
      document.head.appendChild(meta);
    }
  } else {
    if (existingMeta && existingMeta.getAttribute(DYNAMIC_META_ATTR) === 'true') {
      existingMeta.remove();
    }
  }
}

export function updateThemeState() {
  if (typeof window === 'undefined') return;

  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch (e) {
    // localStorage unavailable
  }

  let resolvedTheme: 'light' | 'dark';
  if (stored === 'light' || stored === 'dark') {
    resolvedTheme = stored;
  } else {
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    resolvedTheme = prefersDark ? 'dark' : 'light';
  }

  applyTheme(resolvedTheme);
  updateThemeColorMeta(stored === 'light' || stored === 'dark' ? stored : null);
}

export function registerThemeController() {
  listenerCount++;

  if (listenerCount === 1) {
    if (typeof window !== 'undefined') {
      if (window.matchMedia) {
        mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
        handleMediaChange = () => {
          let stored: string | null = null;
          try {
            stored = window.localStorage.getItem(THEME_STORAGE_KEY);
          } catch (e) {}

          if (stored !== 'light' && stored !== 'dark') {
            updateThemeState();
          }
        };

        if (mediaQueryList.addEventListener) {
          mediaQueryList.addEventListener('change', handleMediaChange);
        } else if ((mediaQueryList as any).addListener) {
          (mediaQueryList as any).addListener(handleMediaChange);
        }
      }

      handleStorageChange = (e: StorageEvent) => {
        if (e.key === THEME_STORAGE_KEY || e.key === null) {
          updateThemeState();
        }
      };
      window.addEventListener('storage', handleStorageChange);
    }
  }

  updateThemeState();

  return () => {
    listenerCount--;
    if (listenerCount === 0) {
      if (mediaQueryList && handleMediaChange) {
        if (mediaQueryList.removeEventListener) {
          mediaQueryList.removeEventListener('change', handleMediaChange);
        } else if ((mediaQueryList as any).removeListener) {
          (mediaQueryList as any).removeListener(handleMediaChange);
        }
        mediaQueryList = null;
        handleMediaChange = null;
      }

      if (handleStorageChange && typeof window !== 'undefined') {
        window.removeEventListener('storage', handleStorageChange);
        handleStorageChange = null;
      }
    }
  };
}

export function ThemeController() {
  useEffect(() => {
    const cleanup = registerThemeController();
    return () => {
      cleanup();
    };
  }, []);

  return null;
}
