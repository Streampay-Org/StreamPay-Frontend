import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import NotificationsPage from './page';

// Mock dependencies
jest.mock('../../components/settings/NotificationSettings', () => ({
  NotificationSettings: ({ onSave, showSaveButton }: any) => (
    <div data-testid="mock-notification-settings">
      {showSaveButton && <button onClick={onSave} data-testid="mock-save-button">Save</button>}
    </div>
  )
}));

const mockSuccess = jest.fn();
jest.mock('../../hooks/useToast', () => ({
  useToast: () => ({
    success: mockSuccess
  })
}));

describe('NotificationsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the page correctly', () => {
    render(<NotificationsPage />);
    
    expect(screen.getByText('User Settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText(/Manage per-category GrantFox/i)).toBeInTheDocument();
    expect(screen.getByTestId('mock-notification-settings')).toBeInTheDocument();
  });

  it('calls success toast when settings are saved', () => {
    render(<NotificationsPage />);
    
    const saveButton = screen.getByTestId('mock-save-button');
    fireEvent.click(saveButton);
    
    expect(mockSuccess).toHaveBeenCalledWith('Notification preferences saved successfully.');
    expect(mockSuccess).toHaveBeenCalledTimes(1);
  });
});
