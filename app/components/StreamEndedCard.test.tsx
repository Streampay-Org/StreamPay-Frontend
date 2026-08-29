import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { StreamEndedCard } from './StreamEndedCard';

describe('StreamEndedCard', () => {
  it('renders correctly with default props', () => {
    render(<StreamEndedCard />);
    expect(screen.getByText('Stream Ended')).toBeInTheDocument();
    expect(screen.getByText(/has successfully concluded/)).toBeInTheDocument();
  });

  it('displays amount and currency when provided', () => {
    render(<StreamEndedCard amount="100.00" currency="USDC" />);
    expect(screen.getByText('Total streamed: 100.00 USDC')).toBeInTheDocument();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = jest.fn();
    render(<StreamEndedCard onDismiss={onDismiss} />);
    const button = screen.getByText('Dismiss');
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onViewDetails when view details button is clicked', () => {
    const onViewDetails = jest.fn();
    render(<StreamEndedCard onViewDetails={onViewDetails} />);
    const button = screen.getByText('View Details');
    fireEvent.click(button);
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });

  it('renders semantic landmarks and status text', () => {
    render(<StreamEndedCard streamName="Alpha Stream" amount="500" currency="XLM" />);
    expect(screen.getByRole('region', { name: 'Stream ended notification for Alpha Stream' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Stream status: Ended' })).toBeInTheDocument();
  });

  it('provides accessible keyboard-operable action buttons', () => {
    const onDismiss = jest.fn();
    const onViewDetails = jest.fn();
    render(<StreamEndedCard streamName="Alpha Stream" onDismiss={onDismiss} onViewDetails={onViewDetails} />);

    const viewBtn = screen.getByRole('button', { name: 'View stream details for Alpha Stream' });
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss notification for Alpha Stream' });

    expect(viewBtn).toBeInTheDocument();
    expect(dismissBtn).toBeInTheDocument();

    viewBtn.focus();
    expect(viewBtn).toHaveFocus();
  });
});
