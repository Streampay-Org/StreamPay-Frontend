/**
 * theme-noflash.test.ts — Tests for no-flash theme utilities
 */

import {
  getTheme,
  applyTheme,
  setTheme,
  initTheme,
  getThemeScript,
} from './theme-noflash';

describe('theme-noflash', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
    document.documentElement.className = '';
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  describe('getTheme', () => {
    it('returns stored theme from localStorage when available', () => {
      localStorage.setItem('streampay-theme', 'light');
      const theme = getTheme();
      expect(theme).toBe('light');
    });

    it('returns stored dark theme from localStorage', () => {
      localStorage.setItem('streampay-theme', 'dark');
      const theme = getTheme();
      expect(theme).toBe('dark');
    });

    it('falls back to system preference when localStorage is empty', () => {
      window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as any;
      const theme = getTheme();
      expect(theme).toBe('dark');
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    });

    it('returns light when system prefers light mode', () => {
      window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as any;
      const theme = getTheme();
      expect(theme).toBe('light');
    });

    it('defaults to dark when localStorage and matchMedia are unavailable', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('localStorage unavailable');
      });
      // @ts-ignore
      delete window.matchMedia;
      const theme = getTheme();
      expect(theme).toBe('dark');
    });

    it('ignores invalid localStorage values', () => {
      localStorage.setItem('streampay-theme', 'invalid');
      window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as any;
      const theme = getTheme();
      expect(theme).toBe('dark');
    });
  });

  describe('applyTheme', () => {
    it('adds dark class to document element', () => {
      applyTheme('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('light')).toBe(false);
    });

    it('adds light class to document element', () => {
      applyTheme('light');
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('stores theme in localStorage', () => {
      applyTheme('light');
      expect(localStorage.getItem('streampay-theme')).toBe('light');
    });
  });

  describe('setTheme', () => {
    it('calls applyTheme with the given theme', () => {
      setTheme('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  describe('initTheme', () => {
    it('detects and applies theme on initialization', () => {
      localStorage.setItem('streampay-theme', 'light');
      initTheme();
      expect(document.documentElement.classList.contains('light')).toBe(true);
    });

    it('applies system preference when no stored theme', () => {
      localStorage.clear();
      window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as any;
      initTheme();
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
  });

  describe('getThemeScript', () => {
    it('returns a valid inline script string', () => {
      const script = getThemeScript();
      expect(typeof script).toBe('string');
      expect(script).toContain('localStorage');
      expect(script).toContain('prefers-color-scheme');
      expect(script).toContain('classList');
    });

    it('includes the correct storage key', () => {
      const script = getThemeScript();
      expect(script).toContain('streampay-theme');
    });

    it('includes both theme classes', () => {
      const script = getThemeScript();
      expect(script).toContain('dark');
      expect(script).toContain('light');
    });

    it('is wrapped in an IIFE', () => {
      const script = getThemeScript();
      expect(script).toMatch(/^\s*\(function\(\)/);
    });
  });

  describe('theme persistence', () => {
    it('persists theme choice across sessions', () => {
      setTheme('light');
      expect(localStorage.getItem('streampay-theme')).toBe('light');
      const retrievedTheme = getTheme();
      expect(retrievedTheme).toBe('light');
    });

    it('allows theme switching', () => {
      setTheme('dark');
      expect(document.documentElement.classList.contains('dark')).toBe(true);

      setTheme('light');
      expect(document.documentElement.classList.contains('light')).toBe(true);
    });
  });
});
