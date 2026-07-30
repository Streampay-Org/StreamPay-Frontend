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

  it('renders category grouped toggles for each notification channel', () => {
    render(<NotificationSettings />);

    expect(screen.getByRole('heading', { name: 'Money Movement' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Product Information' })).toBeInTheDocument();
    expect(screen.getByLabelText('In-app notifications for Stream Started')).toBeInTheDocument();
    expect(screen.getByLabelText('Email notifications for Stream Started')).toBeInTheDocument();
    expect(screen.getByLabelText('In-app notifications for Funding Low')).toBeInTheDocument();
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

  it('renders the save action and calls the save handler when requested', async () => {
    jest.useFakeTimers();
    const onSave = jest.fn();

    render(<NotificationSettings showSaveButton onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
