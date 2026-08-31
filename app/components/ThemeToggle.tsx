'use client';

import React from 'react';
import { useTheme } from '../hooks/useTheme';
import type { ThemeMode } from '../lib/theme';

export function ThemeToggle() {
  const { mode, setMode, highContrast, toggleHighContrast } = useTheme();

  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme selection">
      <label className="theme-toggle__label">
        <input 
          type="radio" 
          name="theme" 
          value="light" 
          checked={mode === 'light'} 
          onChange={() => setMode('light')}
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
          onChange={() => setMode('dark')}
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
          onChange={() => setMode('system')}
          className="theme-toggle__input"
        />
        <span>System</span>
      </label>
      <label className="theme-toggle__label theme-toggle__label--hc">
        <input
          type="checkbox"
          checked={highContrast}
          onChange={toggleHighContrast}
          className="theme-toggle__input"
          aria-label="High contrast mode"
        />
        <span>High Contrast</span>
      </label>
    </div>
  );
}
