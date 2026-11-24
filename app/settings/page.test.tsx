/**
 * @jest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { SettingsPageContent } from './page';
import { SiteHeader } from '../components/SiteHeader';
import { fetchWithIdempotency } from '@/lib/apiClient';

jest.mock('@/lib/apiClient', () => ({
  fetchWithIdempotency: jest.fn(),
}));

const mockedFetchWithIdempotency = fetchWithIdempotency as jest.MockedFunction<
  typeof fetchWithIdempotency
>;

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

describe('SettingsPage display time zone', () => {
  const STORAGE_KEY = 'streampay.display-time-zone';

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders the time zone control with UTC selected by default', () => {
    render(<SettingsPageContent />);

    const select = screen.getByLabelText('Display time zone');

    expect(select).toHaveValue('UTC');
    expect(screen.getByText(/^Preview:/)).toBeInTheDocument();
  });

  it('persists the selection and updates the live preview', () => {
    render(<SettingsPageContent />);

    const select = screen.getByLabelText('Display time zone');
    const previewBefore = screen.getByText(/^Preview:/).textContent;

    fireEvent.change(select, { target: { value: 'America/New_York' } });

    expect(select).toHaveValue('America/New_York');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('America/New_York');

    const previewAfter = screen.getByText(/^Preview:/).textContent;
    expect(previewAfter).toContain('Preview:');
    expect(previewAfter).not.toBe(previewBefore);
  });

  it('restores a stored preference on mount', () => {
    window.localStorage.setItem(STORAGE_KEY, 'Asia/Kolkata');

    render(<SettingsPageContent />);

    expect(screen.getByLabelText('Display time zone')).toHaveValue(
      'Asia/Kolkata'
    );
  });

  it('warns when storage blocks persistence', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    render(<SettingsPageContent />);

    fireEvent.change(screen.getByLabelText('Display time zone'), {
      target: { value: 'Asia/Tokyo' },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      /blocked local storage/i
    );
  });
});


describe('SettingsPage Privacy tab', () => {
    mockedFetchWithIdempotency.mockReset();
  });

    finishDialogClose();
  });

  it('shows the Privacy tab with deletion and retention policy details', () => {

    const privacyTab = screen.getByRole('tab', { name: 'Privacy' });
    expect(privacyTab).toBeInTheDocument();

    fireEvent.click(privacyTab);

    expect(screen.getByRole('heading', { name: 'Privacy' })).toBeInTheDocument();
    expect(screen.getByText(/permanently scrubbed within 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/retained for 7 years/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Request account deletion' })
    ).toBeInTheDocument();
  });

  it('requires typed confirmation and displays the request id on success', async () => {
    mockedFetchWithIdempotency.mockResolvedValueOnce({
      data: {
        requestId: 'dsr-page-001',
        status: 'processing',
        message: 'Your deletion request has been received.',
        completion_estimate: '2026-12-23T12:00:00.000Z',
      },
    });

    render(<SettingsPageContent getAuthToken={() => 'token-123'} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Privacy' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Request account deletion' })
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', {
      name: 'Request account deletion',
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), {
      target: { value: 'DELETE' },
    });
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);

    expect(await screen.findByText('dsr-page-001')).toBeInTheDocument();
    expect(screen.getByText('processing')).toBeInTheDocument();
  });

  it('shows a recoverable error with request_id when deletion fails', async () => {
    mockedFetchWithIdempotency.mockRejectedValueOnce({
      code: 'INTERNAL_ERROR',
      message: 'Failed to process deletion request',
      requestId: 'req-err-500',
    });

    render(<SettingsPageContent getAuthToken={() => 'token-123'} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Privacy' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Request account deletion' })
    );

    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), {
      target: { value: 'DELETE' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Request account deletion' })
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to process deletion request');
    expect(alert).toHaveTextContent('req-err-500');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('guards unsaved notification changes when switching to the Privacy tab', () => {

    openNotificationsTab();
    editNotificationPreference();
    fireEvent.click(screen.getByRole('tab', { name: 'Privacy' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'You have unsaved notification changes',
      })
    ).toBeInTheDocument();
  });
});

  });

  });




  });

      },
    });


    );


    });

    });


  });

    });


    );

    });
    );

  });



      })
  });
});
