/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { SettingsPageContent } from './page';
import { SiteHeader } from '../components/SiteHeader';

jest.mock('../components/ThemeToggle', () => ({
  ThemeToggle: () => <div>Theme controls</div>,
}));

jest.mock('../components/PushOptIn', () => ({
  PushOptIn: ({
    emailFallbackEnabled,
    onEmailFallbackChange,
  }: {
    emailFallbackEnabled: boolean;
    onEmailFallbackChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      onClick={() => onEmailFallbackChange(!emailFallbackEnabled)}
      aria-pressed={emailFallbackEnabled}
    >
      {emailFallbackEnabled ? 'email fallback enabled' : 'email fallback disabled'}
    </button>
  ),
}));

function openNotificationsTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }));
}

function editNotificationPreference() {
  fireEvent.click(screen.getByLabelText('Play notification sounds'));
}

function clickAppearanceTab() {
  fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
}

function finishDialogClose() {
  const overlay = document.querySelector('[data-modal-overlay="true"]');
  if (overlay) fireEvent.animationEnd(overlay);
}

function makeDirtyAndTryToLeave() {
  openNotificationsTab();
  editNotificationPreference();
  clickAppearanceTab();
}

describe('SettingsPage notifications guard', () => {
  afterEach(() => {
    finishDialogClose();
  });

  it('opens the dialog and keeps the Notifications tab active when leaving a dirty form', () => {
    render(<SettingsPageContent />);

    makeDirtyAndTryToLeave();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'You have unsaved notification changes',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Notifications' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Appearance' })
    ).not.toBeInTheDocument();
  });

  it('keeps edits and restores focus to the tab when the dialog is cancelled', () => {
    render(<SettingsPageContent />);

    makeDirtyAndTryToLeave();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    finishDialogClose();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Notifications' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Play notification sounds')).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveFocus();
  });

  it('switches tabs and drops edits when the dialog is discarded', async () => {
    render(<SettingsPageContent />);

    makeDirtyAndTryToLeave();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(
      await screen.findByRole('heading', { name: 'Appearance' })
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Play notification sounds')
    ).not.toBeInTheDocument();
  });

  it('saves and then switches tabs when Save succeeds', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<SettingsPageContent onSaveNotifications={onSave} />);

    makeDirtyAndTryToLeave();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole('heading', { name: 'Appearance' })
    ).toBeInTheDocument();
  });

  it('stays on the dirty form and shows the error when Save rejects', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('offline'));
    render(<SettingsPageContent onSaveNotifications={onSave} />);

    makeDirtyAndTryToLeave();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        /We could not save your notification preferences/i
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Notifications' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Appearance' })
    ).not.toBeInTheDocument();
  });

  it('switches tabs without a dialog when the form is clean', async () => {
    render(<SettingsPageContent />);

    openNotificationsTab();
    clickAppearanceTab();

    expect(
      await screen.findByRole('heading', { name: 'Appearance' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('registers beforeunload while dirty and removes it after saving', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<SettingsPageContent onSaveNotifications={onSave} />);

    openNotificationsTab();
    editNotificationPreference();

    const beforeSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeSave);
    expect(beforeSave.defaultPrevented).toBe(true);

    clickAppearanceTab();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { name: 'Appearance' });

    const afterSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterSave);
    expect(afterSave.defaultPrevented).toBe(false);
  });

  it('blocks SiteHeader link navigation until the dialog is confirmed', () => {
    render(
      <>
        <SiteHeader />
        <SettingsPageContent />
      </>
    );

    openNotificationsTab();
    editNotificationPreference();

    const link = screen.getByRole('link', { name: 'Streams' });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(link, clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Notifications' })
    ).toBeInTheDocument();
  });

  it('has no serious accessibility violations in the confirmation dialog', async () => {
    render(<SettingsPageContent />);

    makeDirtyAndTryToLeave();

    const results = await axe(document.body);

    expect(results).toHaveNoViolations();
  });
});
