/**
 * @jest-environment jsdom
 */

import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen, fireEvent } from '@testing-library/react';
import StreamTypeChip from './StreamTypeChip';
import type { StreamStatus } from './StreamTypeChip';
import '@testing-library/jest-dom';

const styleText = fs.readFileSync(
  path.join(__dirname, 'StreamTypeChip.module.css'),
  'utf8'
);

const patternsCss = fs.readFileSync(
  path.join(__dirname, 'styles', 'patterns.css'),
  'utf8'
);

describe('StreamTypeChip', () => {
  it('renders the type and amount correctly', () => {
    render(<StreamTypeChip type="Video" amount={12345} />);
    
    expect(screen.getByText('Video')).toBeInTheDocument();
    expect(screen.getByText('12345')).toBeInTheDocument();
  });

  it('renders the keyboard hint when provided', () => {
    render(<StreamTypeChip type="Video" amount={12345} kbdHint="V" />);
    
    const kbdElement = screen.getByText('V');
    expect(kbdElement).toBeInTheDocument();
    expect(kbdElement.tagName).toBe('KBD');
    expect(kbdElement).toHaveAttribute('aria-label', 'Keyboard shortcut: V');
  });

  it('uses a stacked layout on narrow viewports and a row layout above the breakpoint', () => {
    expect(styleText).toContain('.streamTypeChip');
    expect(styleText).toContain('flex-direction: column');
    expect(styleText).toContain('@media (min-width: 30rem)');
    expect(styleText).toContain('flex-direction: row');
  });

  it('applies the tabular-nums class for tabular numerals', () => {
    render(<StreamTypeChip type="Audio" amount={67890} />);
    
    const amountElement = screen.getByText('67890');
    expect(amountElement).toHaveClass('tabular-nums');
  });

  it('is reachable via keyboard tab order', () => {
    const { container } = render(<StreamTypeChip type="Video" amount={12345} />);
    const chip = container.querySelector('.stream-type-chip');
    expect(chip).toHaveAttribute('tabIndex', '0');
  });

  it('receives real DOM focus and carries the shared focus-visible class hook', () => {
    const { container } = render(<StreamTypeChip type="Video" amount={12345} />);
    const chip = container.querySelector('.stream-type-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    chip.focus();
    expect(chip).toHaveFocus();
    expect(chip).toHaveClass('stream-type-chip');
  });

  // ── status prop: absent (backward-compat) ───────────────────────────────

  describe('without status prop', () => {
    it('renders without any cb-pattern class when status is omitted', () => {
      const { container } = render(<StreamTypeChip type="Live" amount={1} />);
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      expect(chip.className).not.toMatch(/cb-pattern/);
    });

    it('does not set data-status attribute when status is omitted', () => {
      const { container } = render(<StreamTypeChip type="Live" amount={1} />);
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      expect(chip).not.toHaveAttribute('data-status');
    });
  });

  // ── status prop: each valid status ─────────────────────────────────────

  describe('status prop — pattern class application', () => {
    const statuses: StreamStatus[] = ['active', 'draft', 'paused', 'ended', 'cancelled', 'withdrawn'];

    it.each(statuses)(
      'applies cb-pattern--%s class when status="%s"',
      (status) => {
        const { container } = render(<StreamTypeChip type="T" amount={0} status={status} />);
        const chip = container.querySelector('.stream-type-chip') as HTMLElement;
        expect(chip).toHaveClass(`cb-pattern--${status}`);
      }
    );

    it.each(statuses)(
      'sets data-status="%s" attribute when status="%s"',
      (status) => {
        const { container } = render(<StreamTypeChip type="T" amount={0} status={status} />);
        const chip = container.querySelector('.stream-type-chip') as HTMLElement;
        expect(chip).toHaveAttribute('data-status', status);
      }
    );

    it.each(statuses)(
      'does not apply any other cb-pattern class when status="%s"',
      (status) => {
        const { container } = render(<StreamTypeChip type="T" amount={0} status={status} />);
        const chip = container.querySelector('.stream-type-chip') as HTMLElement;
        const otherStatuses = statuses.filter((s) => s !== status);
        for (const other of otherStatuses) {
          expect(chip).not.toHaveClass(`cb-pattern--${other}`);
        }
      }
    );

    it('always retains stream-type-chip class regardless of status', () => {
      for (const status of statuses) {
        const { container } = render(<StreamTypeChip type="T" amount={0} status={status} />);
        const chip = container.querySelector('.stream-type-chip') as HTMLElement;
        expect(chip).toHaveClass('stream-type-chip');
      }
    });

    it('still renders type and amount correctly when status is set', () => {
      render(<StreamTypeChip type="Salary" amount={5000} status="active" />);
      expect(screen.getByText('Salary')).toBeInTheDocument();
      expect(screen.getByText('5000')).toBeInTheDocument();
    });
  });

  // ── patterns.css — StreamTypeChip selectors present ────────────────────

  describe('patterns.css — StreamTypeChip selectors', () => {
    it('defines per-status overlay selectors for .stream-type-chip', () => {
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--active::before');
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--draft::before');
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--paused::before');
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--ended::before');
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--cancelled::before');
      expect(patternsCss).toContain('.stream-type-chip.cb-pattern--withdrawn::before');
    });

    it('uses a reduced tile/opacity for the compact chip footprint', () => {
      // Extract the StreamTypeChip block from CSS to verify compact settings
      const chipBlock = patternsCss.slice(
        patternsCss.indexOf('.stream-type-chip.cb-pattern--active::before'),
      );
      // background-size should use 8px 8px (compact tile)
      expect(chipBlock).toContain('background-size: 8px 8px');
      // opacity should reference the CSS variable rather than a hard value
      expect(chipBlock).toContain('opacity: calc(var(--cb-pattern-opacity)');
    });
  });

  // ── reduced-motion ──────────────────────────────────────────────────────

  describe('reduced-motion', () => {
    afterEach(() => {
      // @ts-expect-error reset between tests
      delete window.matchMedia;
    });

    it('applies standard transition style and attribute when reduced motion is not requested', () => {
      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }));

      const { container } = render(<StreamTypeChip type="Video" amount={12345} />);
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      
      expect(chip).toHaveAttribute('data-reduced-motion', 'false');
      expect(chip.style.transition).toContain('transform');
    });

    it('renders static fallback (transition/transform none) when reduced motion is requested', () => {
      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }));

      const { container } = render(<StreamTypeChip type="Video" amount={12345} />);
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      
      expect(chip).toHaveAttribute('data-reduced-motion', 'true');
      expect(chip.style.transition).toBe('none');
      expect(chip.style.transform).toBe('none');
    });

    it('applies pattern class even when reduced motion is active', () => {
      window.matchMedia = jest.fn().mockImplementation((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }));

      const { container } = render(<StreamTypeChip type="Video" amount={12345} status="paused" />);
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      expect(chip).toHaveClass('cb-pattern--paused');
      expect(chip).toHaveAttribute('data-reduced-motion', 'true');
    });
  });

  describe('empty state (Issue #1085)', () => {
    it('renders themed empty state when isEmpty is true', () => {
      render(<StreamTypeChip isEmpty />);
      const empty = screen.getByTestId('stream-type-chip-empty-state');
      expect(empty).toBeInTheDocument();
      expect(empty).toHaveAttribute('data-variant', 'stream-type-chip');
      expect(screen.getByText('No stream type selected')).toBeInTheDocument();
      expect(
        screen.getByText(/Pick a stream type to see amount details/)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create a stream' })).toBeInTheDocument();
    });

    it('renders empty state when type is missing or blank', () => {
      const { rerender } = render(<StreamTypeChip type="" amount={0} />);
      expect(screen.getByTestId('stream-type-chip-empty-state')).toBeInTheDocument();

      rerender(<StreamTypeChip type="   " amount={1} />);
      expect(screen.getByTestId('stream-type-chip-empty-state')).toBeInTheDocument();
    });

    it('invokes empty CTA handler when clicked', () => {
      const onEmptyCtaClick = jest.fn();
      render(<StreamTypeChip isEmpty onEmptyCtaClick={onEmptyCtaClick} />);
      fireEvent.click(screen.getByRole('button', { name: 'Create a stream' }));
      expect(onEmptyCtaClick).toHaveBeenCalledTimes(1);
    });

    it('supports custom empty copy and CTA label', () => {
      render(
        <StreamTypeChip
          isEmpty
          emptyTitle="Nothing here"
          emptyDescription="Add a type first."
          emptyCtaText="Browse types"
        />
      );
      expect(screen.getByText('Nothing here')).toBeInTheDocument();
      expect(screen.getByText('Add a type first.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Browse types' })).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('renders Skeleton components when isLoading is true', () => {
      const { container } = render(<StreamTypeChip type="Video" amount={12345} isLoading />);
      
      const chip = container.querySelector('.stream-type-chip') as HTMLElement;
      expect(chip).toHaveAttribute('aria-busy', 'true');
      expect(chip).toHaveAttribute('aria-live', 'polite');
      
      const skeletons = container.querySelectorAll('.skeleton');
      expect(skeletons.length).toBe(2);
      expect(skeletons[0]).toHaveStyle('width: 60px');
      expect(skeletons[1]).toHaveStyle('width: 40px');
    });
  });

  describe('aria-live announcements', () => {
    it('renders a LiveRegion with data-testid stream-type-chip-live', () => {
      render(<StreamTypeChip type="Video" amount={12345} />);
      expect(screen.getByTestId('stream-type-chip-live')).toBeInTheDocument();
    });

    it('has empty announcement on initial render (no false positive)', () => {
      render(<StreamTypeChip type="Video" amount={12345} />);
      const region = screen.getByTestId('stream-type-chip-live');
      expect(region).toHaveTextContent('');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveAttribute('role', 'status');
    });

    it('announces type change via aria-live region', () => {
      const { rerender } = render(<StreamTypeChip type="Video" amount={12345} />);
      rerender(<StreamTypeChip type="Audio" amount={12345} />);
      expect(screen.getByTestId('stream-type-chip-live')).toHaveTextContent(
        'Stream type changed to Audio'
      );
    });

    it('announces amount change via aria-live region', () => {
      const { rerender } = render(<StreamTypeChip type="Video" amount={12345} />);
      rerender(<StreamTypeChip type="Video" amount={999} />);
      expect(screen.getByTestId('stream-type-chip-live')).toHaveTextContent(
        'Stream amount updated to 999'
      );
    });

    it('announces combined type and amount when both change', () => {
      const { rerender } = render(<StreamTypeChip type="Video" amount={12345} />);
      rerender(<StreamTypeChip type="Audio" amount={50} />);
      expect(screen.getByTestId('stream-type-chip-live')).toHaveTextContent(
        'Stream type Audio, amount 50'
      );
    });
  });
});
