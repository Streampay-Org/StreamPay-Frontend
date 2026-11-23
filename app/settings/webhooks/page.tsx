'use client';

/**
 * /settings/webhooks — operator console for webhook subscriptions, the
 * delivery log, dead-letter replay and signing-secret rotation.
 *
 * Security notes for the rotation flow:
 *  - The new secret lives only in React state inside <RotateSecretDialog>.
 *    That component is unmounted when the dialog closes, so the value is
 *    dropped and cannot be shown again.
 *  - It is never written to localStorage/sessionStorage, the URL or the
 *    console, and the subscriptions route never returns stored secrets.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { Tabs, TabDefinition } from '../../components/Tabs';
import { Modal } from '../../components/Modal';

// ── Types (mirrors of the route payloads) ────────────────────────────────────

export interface ConsoleSubscription {
  id: string;
  url: string;
  eventTypes: string[];
  description?: string | null;
  status: 'active' | 'inactive';
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleAttempt {
  attemptNumber: number;
  timestamp: string;
  statusCode?: number;
  error?: string;
  nextRetryAt?: string;
}

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dlq';

export interface ConsoleDelivery {
  deliveryId: string;
  endpointId: string;
  endpointUrl: string;
  eventId: string;
  status: DeliveryStatus;
  attempts: ConsoleAttempt[];
  createdAt: string;
}

export interface ConsoleDLQEntry {
  id: string;
  deliveryId: string;
  endpointId: string;
  endpointUrl: string;
  eventId: string;
  eventType: string;
  reason: string;
  attempts: ConsoleAttempt[];
  createdAt: string;
  replayedDeliveryId: string | null;
  replayedAt: string | null;
}

// ── Shared fetch helper ──────────────────────────────────────────────────────

export interface WebhooksConsoleProps {
  /**
   * Returns the operator's admin bearer token, if the host app has one.
   * When omitted, requests rely on same-origin credentials.
   */
  getAuthToken?: () => string | null | undefined;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

function useApiFetch(getAuthToken?: () => string | null | undefined): ApiFetch {
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      const token = getAuthToken?.();
      if (token) headers.set('authorization', `Bearer ${token}`);

      const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
        throw new ApiError(res.status, error?.code, error?.message ?? `Request failed (${res.status})`);
      }
      return body as T;
    },
    [getAuthToken],
  );
}

function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

const AUTH_MESSAGE = 'You need an admin session to view this. Sign in as an operator and try again.';

function describeLoadError(error: unknown, fallback: string): string {
  return isAuthError(error) ? AUTH_MESSAGE : fallback;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// ── Small presentational pieces ──────────────────────────────────────────────

function LoadingState({ label }: { label: string }) {
  return (
    <p role="status" aria-live="polite">
      {label}
    </p>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert">
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="button button--secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function AttemptHistory({ attempts, id }: { attempts: ConsoleAttempt[]; id: string }) {
  if (attempts.length === 0) {
    return <p id={id}>No attempts recorded yet.</p>;
  }
  return (
    <ol id={id} aria-label="Attempt history">
      {attempts.map((attempt) => (
        <li key={attempt.attemptNumber}>
          Attempt {attempt.attemptNumber} · {formatTime(attempt.timestamp)}
          {attempt.statusCode !== undefined && ` · HTTP ${attempt.statusCode}`}
          {attempt.error && ` · ${attempt.error}`}
          {attempt.nextRetryAt && ` · next retry ${formatTime(attempt.nextRetryAt)}`}
        </li>
      ))}
    </ol>
  );
}

// ── Subscriptions tab ────────────────────────────────────────────────────────

function SubscriptionsTab({ api }: { api: ApiFetch }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: ConsoleSubscription[] }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    api<{ data: ConsoleSubscription[] }>('/api/webhooks/subscriptions')
      .then((body) => active && setState({ kind: 'ready', data: body.data ?? [] }))
      .catch((error) => {
        if (active) {
          setState({ kind: 'error', message: describeLoadError(error, 'Could not load subscriptions.') });
        }
      });
    return () => {
      active = false;
    };
  }, [api, reloadKey]);

  if (state.kind === 'loading') return <LoadingState label="Loading subscriptions…" />;
  if (state.kind === 'error') {
    return <ErrorState message={state.message} onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (state.data.length === 0) return <p>No webhook subscriptions yet.</p>;

  return (
    <table className="webhooks-table">
      <caption>Webhook subscriptions</caption>
      <thead>
        <tr>
          <th scope="col">Endpoint</th>
          <th scope="col">Events</th>
          <th scope="col">Status</th>
          <th scope="col">Signing secret</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {state.data.map((subscription) => (
          <tr key={subscription.id}>
            <td>
              {subscription.url}
              {subscription.description && <div>{subscription.description}</div>}
            </td>
            <td>{subscription.eventTypes.join(', ')}</td>
            <td>{subscription.status}</td>
            <td>{subscription.hasSecret ? 'Configured' : 'Not set'}</td>
            <td>{formatTime(subscription.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Deliveries tab ───────────────────────────────────────────────────────────

const PAGE_SIZES = [20, 50, 100] as const;
const STATUS_FILTERS: Array<'all' | DeliveryStatus> = ['all', 'pending', 'delivered', 'failed', 'dlq'];

interface DeliveriesResponse {
  deliveries: ConsoleDelivery[];
  meta: { hasNext: boolean; nextCursor: string | null; total: number };
}

function DeliveriesTab({ api }: { api: ApiFetch }) {
  const [limit, setLimit] = useState<number>(20);
  const [statusFilter, setStatusFilter] = useState<'all' | DeliveryStatus>('all');
  const [endpointFilter, setEndpointFilter] = useState('');
  const [rows, setRows] = useState<ConsoleDelivery[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'loadingMore'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const idPrefix = useId();

  const loadPage = useCallback(
    (cursor: string | null) =>
      api<DeliveriesResponse>(
        `/api/webhooks/deliveries?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    [api, limit],
  );

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setError(null);
    loadPage(null)
      .then((body) => {
        if (!active) return;
        setRows(body.deliveries ?? []);
        setNextCursor(body.meta?.hasNext ? body.meta.nextCursor : null);
        setTotal(body.meta?.total ?? 0);
        setStatus('ready');
      })
      .catch((err) => {
        if (!active) return;
        setError(describeLoadError(err, 'Could not load the delivery log.'));
        setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [loadPage, reloadKey]);

  const loadMore = async () => {
    if (!nextCursor || status === 'loadingMore') return;
    setStatus('loadingMore');
    setError(null);
    try {
      const body = await loadPage(nextCursor);
      setRows((prev) => [...prev, ...(body.deliveries ?? [])]);
      setNextCursor(body.meta?.hasNext ? body.meta.nextCursor : null);
      setTotal(body.meta?.total ?? total);
      setStatus('ready');
    } catch (err) {
      setError(describeLoadError(err, 'Could not load more deliveries.'));
      setStatus('ready');
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const endpointQuery = endpointFilter.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (statusFilter === 'all' || row.status === statusFilter) &&
      (!endpointQuery ||
        row.endpointUrl.toLowerCase().includes(endpointQuery) ||
        row.endpointId.toLowerCase().includes(endpointQuery)),
  );

  return (
    <div>
      <div className="webhooks-filters" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <label>
          Status
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | DeliveryStatus)}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === 'all' ? 'All statuses' : value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Endpoint
          <input
            type="search"
            value={endpointFilter}
            onChange={(e) => setEndpointFilter(e.target.value)}
            placeholder="URL or endpoint ID"
          />
        </label>
        <label>
          Page size
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      {status === 'loading' && <LoadingState label="Loading deliveries…" />}
      {status === 'error' && error && (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      )}

      {(status === 'ready' || status === 'loadingMore') && (
        <>
          {rows.length === 0 ? (
            <p>No webhook deliveries yet.</p>
          ) : visible.length === 0 ? (
            <p>No loaded deliveries match these filters.</p>
          ) : (
            <table className="webhooks-table">
              <caption>
                Webhook deliveries (showing {visible.length} of {total})
              </caption>
              <thead>
                <tr>
                  <th scope="col">Delivery</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Event</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const isOpen = expanded.has(row.deliveryId);
                  const historyId = `${idPrefix}-history-${row.deliveryId}`;
                  return (
                    <React.Fragment key={row.deliveryId}>
                      <tr>
                        <td>{row.deliveryId}</td>
                        <td>{row.endpointUrl}</td>
                        <td>{row.eventId}</td>
                        <td>{row.status}</td>
                        <td>
                          <button
                            type="button"
                            className="button button--secondary"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? historyId : undefined}
                            aria-label={`${isOpen ? 'Hide' : 'Show'} attempt history for ${row.deliveryId}`}
                            onClick={() => toggle(row.deliveryId)}
                          >
                            {row.attempts.length} {isOpen ? '▲' : '▼'}
                          </button>
                        </td>
                        <td>{formatTime(row.createdAt)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6}>
                            <AttemptHistory attempts={row.attempts} id={historyId} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {error && <ErrorState message={error} />}

          {nextCursor && (
            <button
              type="button"
              className="button button--secondary"
              onClick={loadMore}
              disabled={status === 'loadingMore'}
            >
              {status === 'loadingMore' ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Dead letters tab ─────────────────────────────────────────────────────────

type ReplayState =
  | { kind: 'pending' }
  | { kind: 'replayed' }
  | { kind: 'already' }
  | { kind: 'auth' }
  | { kind: 'failed'; message: string };

function DeadLettersTab({ api }: { api: ApiFetch }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: ConsoleDLQEntry[] }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [replays, setReplays] = useState<Record<string, ReplayState>>({});
  // Synchronous guard: state updates are async, so a fast double-click could
  // otherwise slip a second request through before the button disables.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    api<{ data: ConsoleDLQEntry[] }>('/api/webhooks/dlq')
      .then((body) => active && setState({ kind: 'ready', data: body.data ?? [] }))
      .catch((error) => {
        if (active) {
          setState({ kind: 'error', message: describeLoadError(error, 'Could not load dead letters.') });
        }
      });
    return () => {
      active = false;
    };
  }, [api, reloadKey]);

  const replay = async (entry: ConsoleDLQEntry) => {
    if (inFlight.current.has(entry.id)) return;
    const current = replays[entry.id];
    if (current?.kind === 'replayed' || current?.kind === 'already') return;

    inFlight.current.add(entry.id);
    setReplays((prev) => ({ ...prev, [entry.id]: { kind: 'pending' } }));
    try {
      const body = await api<{ data: { alreadyReplayed: boolean } }>(
        `/api/webhooks/dlq/${encodeURIComponent(entry.id)}/replay`,
        { method: 'POST' },
      );
      setReplays((prev) => ({
        ...prev,
        [entry.id]: { kind: body.data?.alreadyReplayed ? 'already' : 'replayed' },
      }));
    } catch (error) {
      let next: ReplayState;
      if (isAuthError(error)) next = { kind: 'auth' };
      else if (error instanceof ApiError && error.code === 'REPLAY_FAILED') {
        next = { kind: 'failed', message: 'Replay failed. The delivery worker did not accept it — try again.' };
      } else {
        next = { kind: 'failed', message: 'Replay failed. Try again.' };
      }
      setReplays((prev) => ({ ...prev, [entry.id]: next }));
    } finally {
      inFlight.current.delete(entry.id);
    }
  };

  if (state.kind === 'loading') return <LoadingState label="Loading dead letters…" />;
  if (state.kind === 'error') {
    return <ErrorState message={state.message} onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (state.data.length === 0) return <p>The dead-letter queue is empty.</p>;

  return (
    <table className="webhooks-table">
      <caption>Dead-lettered deliveries</caption>
      <thead>
        <tr>
          <th scope="col">Entry</th>
          <th scope="col">Endpoint</th>
          <th scope="col">Event</th>
          <th scope="col">Reason</th>
          <th scope="col">Dead-lettered</th>
          <th scope="col">Action</th>
        </tr>
      </thead>
      <tbody>
        {state.data.map((entry) => {
          const replayState: ReplayState | undefined =
            replays[entry.id] ?? (entry.replayedAt ? { kind: 'already' } : undefined);
          const done = replayState?.kind === 'replayed' || replayState?.kind === 'already';
          const pending = replayState?.kind === 'pending';
          return (
            <tr key={entry.id}>
              <td>{entry.id}</td>
              <td>{entry.endpointUrl}</td>
              <td>
                {entry.eventType} ({entry.eventId})
              </td>
              <td>{entry.reason}</td>
              <td>{formatTime(entry.createdAt)}</td>
              <td>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => replay(entry)}
                  disabled={pending || done}
                  aria-label={`Replay ${entry.id}`}
                >
                  {pending ? 'Replaying…' : replayState?.kind === 'failed' ? 'Retry replay' : 'Replay'}
                </button>
                <div aria-live="polite">
                  {replayState?.kind === 'replayed' && <p role="status">Replay queued.</p>}
                  {replayState?.kind === 'already' && (
                    <p role="status">Already replayed — no new delivery was created.</p>
                  )}
                  {replayState?.kind === 'auth' && <p role="alert">{AUTH_MESSAGE}</p>}
                  {replayState?.kind === 'failed' && <p role="alert">{replayState.message}</p>}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Secret rotation dialog ───────────────────────────────────────────────────

export const MIN_SECRET_LENGTH = 32;

/** 32 random bytes encoded as base64url (43 chars, no padding). */
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function RotateSecretForm({ api, onClose }: { api: ApiFetch; onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputId = useId();
  const errorId = useId();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const secret = draft.trim();
    if (secret.length < MIN_SECRET_LENGTH) {
      setError(`The secret must be at least ${MIN_SECRET_LENGTH} characters.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/webhooks/rotate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      setDraft('');
      setRevealed(secret);
    } catch (err) {
      if (isAuthError(err)) setError(AUTH_MESSAGE);
      else if (err instanceof ApiError && err.status === 422) setError(err.message);
      else setError('Rotation failed. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to the clipboard. Select the secret and copy it manually.');
    }
  };

  if (revealed) {
    return (
      <div>
        <p>
          The signing secret was rotated. Copy it now — <strong>it will not be shown again</strong> once
          you close this dialog.
        </p>
        <label htmlFor={inputId}>New signing secret</label>
        <input
          id={inputId}
          type="text"
          readOnly
          value={revealed}
          autoComplete="off"
          spellCheck={false}
          data-testid="revealed-secret"
          onFocus={(e) => e.currentTarget.select()}
        />
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" className="button button--secondary" onClick={copy} aria-label="Copy secret to clipboard">
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            Done
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <p>
        Enter a new secret of at least {MIN_SECRET_LENGTH} characters, or generate one. The previous secret
        stays valid for a short grace period.
      </p>
      <label htmlFor={inputId}>New signing secret</label>
      <input
        id={inputId}
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoComplete="new-password"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} role="alert">
          {error}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
        <button type="button" className="button button--secondary" onClick={() => setDraft(generateWebhookSecret())}>
          Generate
        </button>
        <button type="button" className="button button--secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Rotating…' : 'Rotate secret'}
        </button>
      </div>
    </form>
  );
}

function RotateSecretDialog({ api, isOpen, onClose }: { api: ApiFetch; isOpen: boolean; onClose: () => void }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Rotate webhook signing secret">
      {/* Mounted only while open, so closing discards every copy of the secret. */}
      {isOpen && <RotateSecretForm api={api} onClose={onClose} />}
    </Modal>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function WebhooksConsoleContent({ getAuthToken }: WebhooksConsoleProps) {
  const api = useApiFetch(getAuthToken);
  const [rotateOpen, setRotateOpen] = useState(false);

  const tabs: TabDefinition[] = [
    { id: 'subscriptions', label: 'Subscriptions', content: <SubscriptionsTab api={api} /> },
    { id: 'deliveries', label: 'Deliveries', content: <DeliveriesTab api={api} /> },
    { id: 'dead-letters', label: 'Dead letters', content: <DeadLettersTab api={api} /> },
  ];

  return (
    <main className="page-shell">
      <header className="page-hero">
        <div className="page-hero__content">
          <p className="page-hero__eyebrow">
            <Link href="/settings">Settings</Link>
          </p>
          <h1 className="page-hero__title">Webhooks</h1>
          <p className="page-hero__description">
            Inspect subscriptions and deliveries, replay dead letters and rotate the signing secret.
          </p>
        </div>
        <button type="button" className="button button--primary" onClick={() => setRotateOpen(true)}>
          Rotate signing secret
        </button>
      </header>

      <div className="settings-layout">
        <Tabs tabs={tabs} defaultTabId="subscriptions" />
      </div>

      <RotateSecretDialog api={api} isOpen={rotateOpen} onClose={() => setRotateOpen(false)} />
    </main>
  );
}

export default function WebhooksSettingsPage() {
  return <WebhooksConsoleContent />;
}
