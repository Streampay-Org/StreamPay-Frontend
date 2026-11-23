import React from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { NotificationSettings } from './NotificationSettings';

jest.mock('../PushOptIn', () => ({
  PushOptIn: ({ emailFallbackEnabled, onEmailFallbackChange }: any) => (
    <button
      type="button"
      onClick={() => onEmailFallbackChange(!emailFallbackEnabled)}
      aria-pressed={emailFallbackEnabled}
    >
      {emailFallbackEnabled ? 'email fallback enabled' : 'email fallback disabled'}
    </button>
  ),
}));

describe('NotificationSettings', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it('renders category grouped toggles for each notification channel and quiet hours', () => {
    render(<NotificationSettings />);

    expect(screen.getByRole('heading', { name: 'Global Preferences' })).toBeInTheDocument();
    expect(screen.getByLabelText('Play notification sounds')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quiet Hours' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Money Movement' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Product Information' })).toBeInTheDocument();
    expect(screen.getByLabelText('In-app notifications for Stream Started')).toBeInTheDocument();
    expect(screen.getByLabelText('Email notifications for Stream Started')).toBeInTheDocument();
    expect(screen.getByLabelText('In-app notifications for Funding Low')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable Quiet Hours schedule')).toBeInTheDocument();
  });

  it('allows channel toggles to change independently within the same notification category', () => {
    render(<NotificationSettings />);

    const inAppToggle = screen.getByLabelText('In-app notifications for Funding Low');
    const emailToggle = screen.getByLabelText('Email notifications for Funding Low');

    expect(inAppToggle).toHaveAttribute('aria-checked', 'true');
    expect(emailToggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(inAppToggle);
    fireEvent.click(emailToggle);

    expect(inAppToggle).toHaveAttribute('aria-checked', 'false');
    expect(emailToggle).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles quiet hours and reveals timezone-safe configuration inputs', () => {
    render(<NotificationSettings />);

    const quietToggle = screen.getByLabelText('Enable Quiet Hours schedule');
    expect(quietToggle).toHaveAttribute('aria-checked', 'false');

    // Enable quiet hours
    fireEvent.click(quietToggle);
    expect(quietToggle).toHaveAttribute('aria-checked', 'true');

    // Controls should now be visible
    expect(screen.getByLabelText(/Start Time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End Time/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Timezone/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Allow critical alerts during quiet hours/i)).toBeInTheDocument();

    // Changing start and end times
    const startInput = screen.getByLabelText(/Start Time/i);
    fireEvent.change(startInput, { target: { value: '23:30' } });
    expect(startInput).toHaveValue('23:30');

    // Changing timezone
    const tzSelect = screen.getByLabelText(/Timezone/i);
    fireEvent.change(tzSelect, { target: { value: 'America/New_York' } });
    expect(tzSelect).toHaveValue('America/New_York');
  });

  it('preserves user input and renders a retry button upon save error', async () => {
    const failingSave = jest.fn().mockRejectedValue(new Error('Network error'));

    render(
      <NotificationSettings
        showSaveButton
        onSave={failingSave}
        initialQuietHours={{ enabled: true, startTime: '22:00', timezone: 'Europe/London' }}
      />
    );

    const startInput = screen.getByLabelText(/Start Time/i);
    fireEvent.change(startInput, { target: { value: '21:45' } });

    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(failingSave).toHaveBeenCalledTimes(1);
    // User data is preserved
    expect(startInput).toHaveValue('21:45');
    // Error and Retry button displayed
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('disables controls in disabled/read-only permission state', () => {
    render(
      <NotificationSettings
        disabled
        initialQuietHours={{ enabled: true, startTime: '22:00', timezone: 'UTC' }}
      />
    );

    expect(screen.getByText(/You do not have permission to modify notification preferences/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Enable Quiet Hours schedule')).toBeDisabled();
    expect(screen.getByLabelText(/Start Time/i)).toBeDisabled();
    expect(screen.getByLabelText(/End Time/i)).toBeDisabled();
    expect(screen.getByLabelText(/Timezone/i)).toBeDisabled();
  });

  it('renders the save action and calls onSave with complete preferences and quietHours', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);

    render(
      <NotificationSettings
        showSaveButton
        onSave={onSave}
        initialQuietHours={{ enabled: true, startTime: '23:00', endTime: '07:00', timezone: 'Asia/Tokyo' }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        quietHours: expect.objectContaining({
          enabled: true,
          startTime: '23:00',
          endTime: '07:00',
          timezone: 'Asia/Tokyo',
        }),
      })
    );
  });

  it('reports dirty state changes to the parent and clears it after save', async () => {
    const onDirtyChange = jest.fn();
    const onSave = jest.fn().mockResolvedValue(undefined);

    render(
      <NotificationSettings
        showSaveButton
        onSave={onSave}
        onDirtyChange={onDirtyChange}
      />
    );

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByLabelText('Play notification sounds'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  // Scenario 8: warning shown when startTime === endTime (issue #1692)
  it('shows always-on warning when startTime equals endTime and is announced accessibly', async () => {
    render(
      <NotificationSettings
        initialQuietHours={{
          enabled: true,
          startTime: '22:00',
          endTime: '22:00',
        }}
      />
    );

    const warning = await screen.findByTestId('quiet-hours-always-on-warning');
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning).toHaveAttribute('aria-live', 'polite');
    expect(warning.textContent).toMatch(/all day/i);
  });

  it('does not show always-on warning when startTime differs from endTime', () => {
    render(
      <NotificationSettings
        initialQuietHours={{
          enabled: true,
          startTime: '22:00',
          endTime: '08:00',
        }}
      />
    );

    expect(screen.queryByTestId('quiet-hours-always-on-warning')).not.toBeInTheDocument();
  });
});
