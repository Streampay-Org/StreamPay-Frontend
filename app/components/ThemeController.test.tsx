/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { ThemeController } from './ThemeController';

describe('ThemeController', () => {
  let mediaQueryCallbacks: Array<(e: Partial<MediaQueryListEvent>) => void> = [];
  let addEventListenerSpy: jest.Mock;
  let removeEventListenerSpy: jest.Mock;
  let matchesState = false;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((el) => el.remove());
    mediaQueryCallbacks = [];
    matchesState = false;

    addEventListenerSpy = jest.fn((event, cb) => {
      if (event === 'change') mediaQueryCallbacks.push(cb);
    });
    removeEventListenerSpy = jest.fn((event, cb) => {
      if (event === 'change') {
        mediaQueryCallbacks = mediaQueryCallbacks.filter((fn) => fn !== cb);
      }
    });

    const mockMatchMedia = jest.fn().mockImplementation((query) => {
      return {
        get matches() {
          return matchesState;
        },
        media: query,
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
        dispatchEvent: jest.fn(),
      };
    });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: mockMatchMedia,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('1. With no stored theme, changing OS preference from dark to light updates root HTML theme when ThemeToggle is not mounted', () => {
    matchesState = false;
    render(<ThemeController />);
    expect(document.documentElement.classList.contains('light')).toBe(true);

    act(() => {
      matchesState = true;
      mediaQueryCallbacks.forEach((cb) => cb({ matches: true }));
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      matchesState = false;
      mediaQueryCallbacks.forEach((cb) => cb({ matches: false }));
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
  });

  it('2. With an explicit stored dark theme, OS preference changes do not alter the theme', () => {
    localStorage.setItem('streampay-theme', 'dark');
    render(<ThemeController />);

    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      matchesState = false;
      mediaQueryCallbacks.forEach((cb) => cb({ matches: false }));
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('7. Mounting two controllers accidentally results in only one active media-query listener; verify listener registration with a spy and test cleanup', () => {
    const { unmount: unmount1 } = render(<ThemeController />);
    const { unmount: unmount2 } = render(<ThemeController />);

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);

    unmount1();
    expect(removeEventListenerSpy).not.toHaveBeenCalled();

    unmount2();
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
  });

  it('9. Regression test: global System-theme switching scenario works with controller mounted independently of ThemeToggle', () => {
    matchesState = false;
    render(<ThemeController />);

    // Initially light mode because matchesState is false
    expect(document.documentElement.classList.contains('light')).toBe(true);

    // OS changes to dark
    act(() => {
      matchesState = true;
      mediaQueryCallbacks.forEach((cb) => cb({ matches: true }));
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
