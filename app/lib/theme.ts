/**
 * Theme management utilities.
 * Persists theme choice in localStorage and applies it to the document root
 * without blocking first paint (see getThemeScript).
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ColorScheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'streampay-theme';
export const HIGH_CONTRAST_STORAGE_KEY = 'streampay-high-contrast';

const VALID_THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (VALID_THEME_MODES as string[]).includes(value);
}

export function getStoredTheme(): ThemeMode {
  try {
    if (typeof window === 'undefined') return 'system';
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // Ignore storage errors (private mode, disabled cookies, etc.)
  }
  return 'system';
}

export function setStoredTheme(mode: ThemeMode): void {
  try {
    if (typeof window === 'undefined') return;
    if (mode === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  } catch {
    // Ignore storage errors.
  }
}

export function getStoredHighContrast(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStoredHighContrast(value: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) {
      window.localStorage.setItem(HIGH_CONTRAST_STORAGE_KEY, 'true');
    } else {
      window.localStorage.removeItem(HIGH_CONTRAST_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
}

export function getSystemColorScheme(): ColorScheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveColorScheme(
  mode: ThemeMode,
  systemScheme: ColorScheme = getSystemColorScheme()
): ColorScheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemScheme;
}

/**
 * Applies the given theme mode and high-contrast flag to <html>.
 * Safe to call on the server (no-op) and client.
 */
export function applyTheme(mode: ThemeMode, highContrast: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const scheme = resolveColorScheme(mode);
  root.classList.remove('light', 'dark');
  root.classList.add(scheme);
  root.classList.toggle('high-contrast', highContrast);
}

/**
 * Persists the theme mode and applies it immediately.
 */
export function setTheme(mode: ThemeMode): void {
  setStoredTheme(mode);
  applyTheme(mode, getStoredHighContrast());
}

/**
 * Persists the high-contrast flag and applies it immediately.
 */
export function setHighContrast(value: boolean): void {
  setStoredHighContrast(value);
  applyTheme(getStoredTheme(), value);
}

/**
 * Returns the currently stored high-contrast flag.
 */
export function getHighContrast(): boolean {
  return getStoredHighContrast();
}

/**
 * Inline script injected in <head> to prevent a flash of the wrong theme.
 * It reads the persisted preference synchronously and sets classes before first paint.
 * It must not depend on external scripts or block rendering (it is intentionally small).
 */
export function getThemeScript(): string {
  return `(function(){try{var mode=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE_KEY
  )});var scheme=mode==='light'?'light':mode==='dark'?'dark':(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var hc=localStorage.getItem(${JSON.stringify(
    HIGH_CONTRAST_STORAGE_KEY
  ))})==='true';var d=document.documentElement;d.classList.remove('light','dark');d.classList.add(scheme);if(hc){d.classList.add('high-contrast');}else{d.classList.remove('high-contrast');}}catch(e){}})();`