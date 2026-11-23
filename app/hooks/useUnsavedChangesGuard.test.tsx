/**
 * @jest-environment jsdom
 */

import React from 'react';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';

function LinkHarness({
  isDirty,
  onConfirm,
  href = '/dashboard',
  onLinkClick,
}: {
  isDirty: boolean;
  onConfirm: (origin?: HTMLElement | null) => Promise<boolean>;
  href?: string;
  onLinkClick?: jest.Mock;
}) {
  useUnsavedChangesGuard({ isDirty, onConfirm });
  return (
    <div>
      <a
        href={href}
        onClick={(event) => {
          onLinkClick?.();
          // Keep jsdom from performing an actual navigation so the test can
          // assert whether the guard let the click through.
          event.preventDefault();
        }}
      >
        Navigate
      </a>
    </div>
  );
}

function dispatchBeforeUnload() {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('useUnsavedChangesGuard', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('registers beforeunload only while dirty and removes it when clean', () => {
    const onConfirm = jest.fn().mockResolvedValue(false);
    const { rerender } = renderHook(
      ({ isDirty }) => useUnsavedChangesGuard({ isDirty, onConfirm }),
      { initialProps: { isDirty: true } }
    );

    expect(dispatchBeforeUnload()).toBe(true);

    rerender({ isDirty: false });

    expect(dispatchBeforeUnload()).toBe(false);
  });

  it('blocks same-origin link clicks and asks for confirmation', async () => {
    const onConfirm = jest.fn().mockResolvedValue(false);
    const onLinkClick = jest.fn();
    render(
      <LinkHarness
        isDirty
        onConfirm={onConfirm}
        onLinkClick={onLinkClick}
      />
    );

    const link = screen.getByRole('link', { name: 'Navigate' });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(link, clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    // The guard stops propagation, so Next.js/React never sees the click.
    expect(onLinkClick).not.toHaveBeenCalled();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0]).toBe(link);
  });

  it('ignores cross-origin links and clicks with modifier keys', () => {
    const onConfirm = jest.fn().mockResolvedValue(false);
    const onLinkClick = jest.fn();
    const { rerender } = render(
      <LinkHarness
        isDirty
        onConfirm={onConfirm}
        href="https://example.com"
        onLinkClick={onLinkClick}
      />
    );

    const external = screen.getByRole('link', { name: 'Navigate' });
    const externalEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(external, externalEvent);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onLinkClick).toHaveBeenCalledTimes(1);

    rerender(
      <LinkHarness
        isDirty
        onConfirm={onConfirm}
        href="/dashboard"
        onLinkClick={onLinkClick}
      />
    );
    const internal = screen.getByRole('link', { name: 'Navigate' });
    const modifiedEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    fireEvent(internal, modifiedEvent);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onLinkClick).toHaveBeenCalledTimes(2);
  });

  it('does not intercept links when the form is clean', () => {
    const onConfirm = jest.fn().mockResolvedValue(false);
    const onLinkClick = jest.fn();
    render(
      <LinkHarness
        isDirty={false}
        onConfirm={onConfirm}
        onLinkClick={onLinkClick}
      />
    );

    const link = screen.getByRole('link', { name: 'Navigate' });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(link, clickEvent);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it('exposes confirmNavigation and short-circuits when clean', async () => {
    const onConfirm = jest.fn().mockResolvedValue(false);
    const { result, rerender } = renderHook(
      ({ isDirty }) => useUnsavedChangesGuard({ isDirty, onConfirm }),
      { initialProps: { isDirty: true } }
    );

    await act(async () => {
      await expect(result.current.confirmNavigation()).resolves.toBe(false);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender({ isDirty: false });

    await act(async () => {
      await expect(result.current.confirmNavigation()).resolves.toBe(true);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
