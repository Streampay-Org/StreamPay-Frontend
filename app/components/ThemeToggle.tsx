'use client';

import React, { useEffect, useState } from 'react';
import { setTheme, setHighContrast, getHighContrast } from '../utils/theme-noflash';
import { updateThemeState } from './ThemeController';

type ThemeMode = 'light' | 'dark' | 'system';

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('system');
  const [highContrast, setHighContrastState] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('streampay-theme');
      if (stored === 'light' || stored === 'dark') {
        setMode(stored);
      } else {
        setMode('system');
      }
    } catch (e) {
      setMode('system');
    }
  }, []);

  useEffect(() => {
    setHighContrastState(getHighContrast());
  }, []);

  const handleChange = (newMode: ThemeMode) => {
    setMode(newMode);

    if (newMode === 'system') {
      try {
        window.localStorage.removeItem('streampay-theme');
      } catch (e) {}
      updateThemeState();
    } else {
      setTheme(newMode);
      updateThemeState();
    }
  };

  const handleHighContrastToggle = () => {
    const next = !highContrast;
    setHighContrastState(next);
    setHighContrast(next);
  };

  return (
    <div className="theme-toggle">
      <fieldset className="theme-toggle__group">
        <legend className="sr-only">Theme selection</legend>
        <label className="theme-toggle__label">
          <input
            type="radio"
            name="theme"
            value="light"
            checked={mode === 'light'}
            onChange={() => handleChange('light')}
            className="theme-toggle__input"
          />
          <span>Light</span>
        </label>
        <label className="theme-toggle__label">
          <input
            type="radio"
            name="theme"
            value="dark"
            checked={mode === 'dark'}
            onChange={() => handleChange('dark')}
            className="theme-toggle__input"
          />
          <span>Dark</span>
        </label>
        <label className="theme-toggle__label">
          <input
            type="radio"
            name="theme"
            value="system"
            checked={mode === 'system'}
            onChange={() => handleChange('system')}
            className="theme-toggle__input"
          />
          <span>System</span>
        </label>
      </fieldset>
      <label className="theme-toggle__label theme-toggle__label--hc">
        <input
          type="checkbox"
          aria-label="High contrast mode"
          checked={highContrast}
          onChange={handleHighContrastToggle}
          className="theme-toggle__input"
        />
        <span>High Contrast</span>
      </label>
    </div>
  );
}
