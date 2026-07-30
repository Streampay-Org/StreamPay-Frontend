"use client";

import React, { useEffect, useRef, useState } from 'react';
import '../src/styles/typography.css'; // Adjust path if needed
import styles from './StreamTypeChip.module.css';
import { LiveRegion } from '../src/components/LiveRegion';

/**
 * Tracks the user's `prefers-reduced-motion` setting.
 */
function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }

    query.addListener(onChange);
    return () => query.removeListener(onChange);
  }, []);

  return prefersReduced;
}

/** Valid stream lifecycle statuses for color-blind pattern fills. */
export type StreamStatus =
  | 'active'
  | 'draft'
  | 'paused'
  | 'ended'
  | 'cancelled'
  | 'withdrawn';

/**
 * StreamTypeChip component.
 * Displays a stream type and an amount using tabular figures for better alignment.
 * Announces type/amount changes to assistive technologies via an aria-live region.
 *
 * @param {string} type - The type of stream.
 * @param {number} amount - The amount associated with the stream.
 * @param {boolean} isLoading - Whether the chip is loading.
 */
export interface StreamTypeChipProps {
  type: string;
  amount: number;
  isLoading?: boolean;
}

export const StreamTypeChip: React.FC<StreamTypeChipProps> = ({ type, amount, isLoading = false }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const showEmpty =
    isEmpty ||
    type === undefined ||
    type === null ||
    (typeof type === 'string' && type.trim() === '');

  if (showEmpty) {
    return (
      <EmptyState
        title={emptyTitle ?? 'No stream type selected'}
        description={
          emptyDescription ??
          'Pick a stream type to see amount details, or create a new stream to get started.'
        }
        illustration={<StreamTypeChipEmptyIllustration />}
        ctaText={emptyCtaText ?? 'Create a stream'}
        onCtaClick={onEmptyCtaClick}
        className={`stream-type-chip-empty ${className}`.trim()}
        testId="stream-type-chip-empty-state"
        variant="stream-type-chip"
      />
    );
  }

  const chipLabel = `${type} ${amount}`;

  const patternClass = status ? `cb-pattern--${status}` : '';

  if (isLoading) {
    return (
      <div
        className={`${styles.streamTypeChip} stream-type-chip`}
        data-reduced-motion={prefersReducedMotion}
        style={{
          transition: prefersReducedMotion ? 'none' : 'transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease',
          transform: prefersReducedMotion ? 'none' : undefined,
          cursor: 'default',
        }}
        aria-busy="true"
        aria-live="polite"
      >
        <Skeleton width={60} height={20} />
        <Skeleton width={40} height={20} />
      </div>
    );
  }

  // ── ARIA live announcements ────────────────────────────────────────────────
  const [srAnnouncement, setSrAnnouncement] = useState('');
  const prevTypeRef = useRef<string | null>(null);
  const prevAmountRef = useRef<number | null>(null);

  useEffect(() => {
    const prevType = prevTypeRef.current;
    const prevAmount = prevAmountRef.current;

    // First render — seed refs without announcing (avoid false positives).
    if (prevType === null) {
      prevTypeRef.current = type;
      prevAmountRef.current = amount;
      return;
    }

    const typeChanged = prevType !== type;
    const amountChanged = prevAmount !== amount;

    if (typeChanged && amountChanged) {
      setSrAnnouncement(`Stream type ${type}, amount ${amount}`);
    } else if (typeChanged) {
      setSrAnnouncement(`Stream type changed to ${type}`);
    } else if (amountChanged) {
      setSrAnnouncement(`Stream amount updated to ${amount}`);
    }

    prevTypeRef.current = type;
    prevAmountRef.current = amount;
  }, [type, amount]);

  return (
    <div
      className={[styles.streamTypeChip, 'stream-type-chip', patternClass].filter(Boolean).join(' ')}
      tabIndex={0}
      data-reduced-motion={prefersReducedMotion}
      data-status={status ?? undefined}
      style={{
        transition: prefersReducedMotion ? 'none' : 'transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease',
        transform: prefersReducedMotion ? 'none' : undefined,
      }}
    >
      {/* Screen-reader live announcements for type / amount changes */}
      <LiveRegion message={srAnnouncement} data-testid="stream-type-chip-live" />

      <span className={styles.type}>{type}</span>
      <span className={`tabular-nums ${styles.amount}`}>
        {amount ?? 0}
      </span>
      {kbdHint && <KbdHint shortcut={kbdHint} />}
    </div>
  );
};

export default StreamTypeChip;
