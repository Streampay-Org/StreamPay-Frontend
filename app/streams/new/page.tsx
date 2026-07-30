'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { GasOnRecipientToggle } from '../../components/GasOnRecipientToggle';
import { RecentRecipients } from './components/RecentRecipients';
import { addRecentRecipient } from '../../state/recentRecipients';
import { BottomSheet } from '../../components/BottomSheet';
import {
  getWizardDraft,
  saveWizardDraft,
  clearWizardDraft,
} from '../../state/wizardDraft';

function shortenAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * New Stream page (single-recipient).
 *
 * ### Save draft (#863)
 * All form fields are written to localStorage on every change via
 * `saveWizardDraft()`.  On mount, `getWizardDraft()` restores a
 * previously saved draft so work-in-progress survives navigation,
 * accidental tab closes, and page refreshes.
 *
 * A "Saved draft" banner is shown when a draft was restored, giving
 * the user clear feedback that their previous input is back. A
 * "Discard draft" control lets them start clean.
 *
 * The draft is cleared with `clearWizardDraft()` on successful
 * stream creation so stale state is never re-loaded.
 *
 * ### Mobile bottom-sheet (#528)
 * Intercepts form submission on mobile viewports (< 768 px) to display
 * a bottom-sheet summary before final submission.
 */
export default function NewStreamPage() {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState<'XLM' | 'USDC'>('XLM');
  const [gasOnRecipient, setGasOnRecipient] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const [isMobile, setIsMobile] = useState(false);
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);

  /**
   * Whether a saved draft was restored on mount.  When true, a banner
   * is displayed so the user knows their previous work has been recovered.
   */
  const [draftRestored, setDraftRestored] = useState(false);

  /* ── Restore draft on mount ─────────────────────────────────────── */
  useEffect(() => {
    const draft = getWizardDraft();
    if (draft) {
      setRecipient(draft.recipient);
      setAmount(draft.amount);
      setToken(draft.token);
      setGasOnRecipient(draft.gasOnRecipient);
      setDraftRestored(true);
    }
  }, []);

  /* ── Persist draft on every field change ────────────────────────── */
  // Wrapped in useCallback so lint is happy; the identity is stable per render
  const persistDraft = useCallback(() => {
    saveWizardDraft({ recipient, amount, token, gasOnRecipient });
  }, [recipient, amount, token, gasOnRecipient]);

  useEffect(() => {
    persistDraft();
  }, [persistDraft]);

  /* ── Discard draft ───────────────────────────────────────────────── */
  const handleDiscardDraft = () => {
    clearWizardDraft();
    setRecipient('');
    setAmount('');
    setToken('XLM');
    setGasOnRecipient(false);
    setDraftRestored(false);
  };

  /* ── Mobile detection ────────────────────────────────────────────── */
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    setIsMobile(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    mediaQuery.addEventListener('change', listener);
    return () => {
      mediaQuery.removeEventListener('change', listener);
    };
  }, []);

  // Auto-close bottom sheet if viewport is resized to desktop width
  useEffect(() => {
    if (!isMobile) {
      setIsBottomSheetOpen(false);
    }
  }, [isMobile]);

  /* ── Stream creation ─────────────────────────────────────────────── */
  const performCreateStream = async () => {
    setIsSubmitting(true);
    setIsBottomSheetOpen(false);
    // TODO: call stream creation API with { recipient, amount, token, gasOnRecipient }
    await new Promise((resolve) => setTimeout(resolve, 800));
    addRecentRecipient(recipient);
    // Clear the draft now that creation has succeeded
    clearWizardDraft();
    setIsSubmitting(false);
    setSuccess(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isMobile) {
      setIsBottomSheetOpen(true);
    } else {
      performCreateStream();
    }
  };

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--panel)',
    border: '1px solid var(--border)',
    color: 'var(--foreground)',
    padding: '0.75rem',
    borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-base)',
  };

  /* ── Success screen ──────────────────────────────────────────────── */
  if (success) {
    return (
      <main className="page-shell">
        <section className="page-hero">
          <div>
            <p className="page-hero__eyebrow">Success</p>
            <h1 className="page-hero__title">Stream Created</h1>
            <p className="page-hero__description">Your stream is live.</p>
          </div>
          <Link href="/streams" className="button button--primary">View Streams</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <section className="page-hero">
        <div>
          <p className="page-hero__eyebrow">New Stream</p>
          <h1 className="page-hero__title">Create Stream</h1>
          <p className="page-hero__description">
            Set up a continuous payment stream to a Stellar address.
          </p>
        </div>
      </section>

      {/* ── Saved-draft banner ────────────────────────────────────── */}
      {draftRestored && (
        <section
          aria-live="polite"
          className="draft-banner"
          data-testid="draft-restored-banner"
          role="status"
        >
          <span className="draft-banner__icon" aria-hidden="true">📝</span>
          <p className="draft-banner__message">
            <strong>Draft restored</strong> — your previous inputs have been
            recovered. Continue where you left off, or{' '}
            <button
              type="button"
              className="draft-banner__discard"
              onClick={handleDiscardDraft}
              data-testid="discard-draft-btn"
            >
              discard draft
            </button>
            .
          </p>
        </section>
      )}

      <section style={{ maxWidth: '560px', margin: '0 auto 1.5rem', padding: '0 1.5rem' }}>
        <div
          className="csf-cta-banner"
          data-testid="csf-cta-banner"
        >
          <div>
            <p style={{ margin: 0, fontWeight: 600 }}>Need a fan-out split?</p>
            <p style={{ margin: '0.25rem 0 0', color: 'var(--muted-light)', fontSize: 'var(--text-sm)' }}>
              Create one stream with percentage-based allocations for multiple recipients.
            </p>
          </div>
          <Link href="/streams/new/multi" className="button button--secondary">
            Create Multi-Recipient Stream
          </Link>
        </div>
      </section>

      <section style={{ maxWidth: '560px', margin: '0 auto', padding: '0 1.5rem' }}>
        <div
          className={`create-stream-status ${success ? 'create-stream-status--active' : 'create-stream-status--draft'}`}
          role="status"
          aria-label={success ? 'Stream created successfully' : 'Form ready'}
        />
        <form
          onSubmit={handleSubmit}
          data-testid="create-stream-form"
          className="create-stream-form"
          style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
        >
          {/* Recipient */}
          <div>
            <label
              htmlFor="recipient"
              style={{ display: 'block', fontSize: 'var(--text-sm)', marginBottom: '0.5rem', color: 'var(--muted-light)' }}
            >
              Recipient address
            </label>
            <RecentRecipients
              onSelect={setRecipient}
              className="recent-recipients--inline"
            />
            <input
              id="recipient"
              type="text"
              required
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="GABC..."
              className="csf-field"
              style={{ ...fieldStyle, marginTop: '0.5rem' }}
            />
          </div>

          {/* Amount + token */}
          <div className="csf-field-row" data-testid="csf-field-row" style={{ gap: '1rem' }}>
            <div>
              <label
                htmlFor="amount"
                style={{ display: 'block', fontSize: 'var(--text-sm)', marginBottom: '0.5rem', color: 'var(--muted-light)' }}
              >
                Amount
              </label>
              <input
                id="amount"
                type="number"
                required
                min="0.0000001"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100"
                className="csf-field"
                style={fieldStyle}
              />
            </div>
            <div>
              <label
                htmlFor="token"
                style={{ display: 'block', fontSize: 'var(--text-sm)', marginBottom: '0.5rem', color: 'var(--muted-light)' }}
              >
                Token
              </label>
              <select
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value as 'XLM' | 'USDC')}
                className="csf-field"
                style={fieldStyle}
              >
                <option value="XLM">XLM</option>
                <option value="USDC">USDC</option>
              </select>
            </div>
          </div>

          {/* Gas-on-recipient toggle — #528 */}
          <GasOnRecipientToggle
            enabled={gasOnRecipient}
            onChange={setGasOnRecipient}
            token={token}
          />

          {/* Actions */}
          <div className="csf-actions" data-testid="csf-actions">
            <button
              type="button"
              className="button button--secondary csf-field"
              onClick={() => window.history.back()}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`button button--primary${isSubmitting ? ' button--busy cb-pattern--draft' : ''}`}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating…' : 'Create Stream'}
            </button>
          </div>
        </form>
      </section>

      {/* Mobile Summary Bottom Sheet */}
      <BottomSheet
        isOpen={isBottomSheetOpen}
        onClose={() => setIsBottomSheetOpen(false)}
        title="Review Stream Details"
        reducedMotion={prefersReducedMotion}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <p style={{ color: 'var(--muted-light)', fontSize: 'var(--text-sm, 0.875rem)', margin: 0 }}>
            Double-check the payment stream details below before finalizing.
          </p>

          <dl
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md, 8px)',
              padding: '1.25rem',
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
              <dt style={{ color: 'var(--muted)' }}>Recipient</dt>
              <dd style={{ fontWeight: 600, margin: 0, overflowWrap: 'anywhere', textAlign: 'right' }} title={recipient}>
                {shortenAddress(recipient)}
              </dd>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
              <dt style={{ color: 'var(--muted)' }}>Amount</dt>
              <dd style={{ fontWeight: 600, margin: 0, textAlign: 'right' }}>
                {amount} {token}
              </dd>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
              <dt style={{ color: 'var(--muted)' }}>Fee Bearer</dt>
              <dd style={{ fontWeight: 600, margin: 0, textAlign: 'right' }}>
                {gasOnRecipient ? 'Recipient' : 'You (Sender)'}
              </dd>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)' }}>
              <dt style={{ color: 'var(--muted)' }}>Est. Network Fee</dt>
              <dd style={{ fontWeight: 600, margin: 0, textAlign: 'right' }}>
                {gasOnRecipient ? '0.00001 XLM deducted' : '~0.00001 XLM'}
              </dd>
            </div>
          </dl>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
              marginTop: '0.5rem',
            }}
          >
            <button
              type="button"
              className={`button button--primary${isSubmitting ? ' button--busy cb-pattern--draft' : ''}`}
              disabled={isSubmitting}
              onClick={performCreateStream}
              style={{ width: '100%', minHeight: '2.75rem' }}
            >
              {isSubmitting ? 'Creating…' : 'Confirm & Create'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={isSubmitting}
              onClick={() => setIsBottomSheetOpen(false)}
              style={{ width: '100%', minHeight: '2.75rem' }}
            >
              Cancel
            </button>
          </div>
        </div>
      </BottomSheet>
    </main>
  );
}
