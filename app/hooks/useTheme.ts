'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyTheme,
  getStoredHighContrast,
  getStoredTheme,
  setStoredHighContrast,
  setStoredTheme,
  ThemeMode,
} from '../lib/theme';

/**
 * React hook that manages theme mode and high-contrast state.
 * It reads persisted preferences on mount and keeps the DOM in sync.
 */
export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [highContrast, setHighContrastState] = useState(false);
  const isInitialized = useRef(false);

  // Load persisted values on mount and apply them immediately to avoid a flash.
  useEffect(() => {
    const storedMode = getStoredTheme();
    const storedHighContrast = getStoredHighContrast();
    setModeState(storedMode);
    setHighContrastState(storedHighContrast);
    applyTheme(storedMode, storedHighContrast);
    isInitialized.current = true;
  }, []);

  // Apply theme on subsequent state changes.
  useEffect(() => {
    if (!isInitialized.current) return;
    applyTheme(mode, highContrast);
  }, [mode, highContrast]);

  // Follow system changes when mode is 'system'.
  useEffect(() => {
    if (!isInitialized.current || mode !== 'system') return;
    if (typeof window === 'undefined') return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => applyTheme('system', highContrast);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mode, highContrast]);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    setStoredTheme(newMode);
  }, []);

  const setHighContrast = useCallback((next: boolean) => {
    setHighContrastState(next);
    setStoredHighContrast(next);
  }, []);

  const toggleHighContrast = useCallback(() => {
    setHighContrast(!highContrast);
  }, [highContrast, setHighContrast]);

  return {
    mode,
    setMode,
    highContrast,
    setHighContrast,
    toggleHighContrast,
  };
}
