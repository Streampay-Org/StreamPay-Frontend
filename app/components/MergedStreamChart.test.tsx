import React from 'react';
import { render, screen } from '@testing-library/react';
import { MergedStreamChart } from './MergedStreamChart';

describe('MergedStreamChart', () => {
  it('renders empty state when no streams are provided', () => {
    render(<MergedStreamChart streams={[]} />);
    expect(screen.getByText('No streams available')).toBeInTheDocument();
  });

  it('renders aggregated progress correctly', () => {
    const streams = [
      { id: '1', status: 'active' as const, accruedAmount: 10, totalAmount: 100, name: 'Stream 1' },
      { id: '2', status: 'active' as const, accruedAmount: 20, totalAmount: 100, name: 'Stream 2' },
    ];
    render(<MergedStreamChart streams={streams} />);
    
    expect(screen.getByText('Total Merged Progress')).toBeInTheDocument();
    expect(screen.getByText('Breakdown by Stream')).toBeInTheDocument();
    
    // Total accrued = 30, Total amount = 200 -> 15% accrued
    expect(screen.getByText('15% accrued')).toBeInTheDocument();
    
    // Individual streams
    expect(screen.getByText('Stream 1')).toBeInTheDocument();
    expect(screen.getByText('10% accrued')).toBeInTheDocument();
    
    expect(screen.getByText('Stream 2')).toBeInTheDocument();
    expect(screen.getByText('20% accrued')).toBeInTheDocument();
  });

  it('calculates aggregate status as ended when all streams are ended', () => {
    const streams = [
      { id: '1', status: 'ended' as const, accruedAmount: 100, totalAmount: 100 },
      { id: '2', status: 'ended' as const, accruedAmount: 50, totalAmount: 50 },
    ];
    const { container } = render(<MergedStreamChart streams={streams} />);
    // All ended streams are 100% completed
    const completedLabels = screen.getAllByText('Completed');
    // 2 individual + 1 aggregated = 3 "Completed" labels
    expect(completedLabels).toHaveLength(3);
  });
});
