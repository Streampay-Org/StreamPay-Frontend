import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import WebhooksSettingsPage, { generateWebhookSecret, WebhooksConsoleContent } from './page';

// ── fetch mock ───────────────────────────────────────────────────────────────

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

let handlers: Record<string, Handler>;
const fetchMock = jest.fn();

function json(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function route(url: string): string {
  const path = url.split('?')[0];
  if (/^\/api\/webhooks\/dlq\/[^/]+\/replay$/.test(path)) return 'replay';
  return path;
}

beforeEach(() => {
  handlers = {
    '/api/webhooks/subscriptions': () => ({ body: { data: [], meta: { total: 0 } } }),
    '/api/webhooks/deliveries': () => ({
      body: { deliveries: [], meta: { hasNext: false, nextCursor: null, total: 0 } },
    }),
    '/api/webhooks/dlq': () => ({ body: { data: [], meta: { total: 0 } } }),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const handler = handlers[route(url)];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    const { status = 200, body } = await handler(url, init);
    return json(status, body);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function callsTo(key: string) {
  return fetchMock.mock.calls.filter(([url]) => route(url) === key);
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const subscription = {
  id: 'whs_1',
  url: 'https://merchant.example/hooks',
  eventTypes: ['stream.created', 'stream.settled'],
  description: 'Primary',
  status: 'active',
  hasSecret: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function delivery(id: string, overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: id,
    endpointId: 'ep-1',
    endpointUrl: 'https://a.example/hook',
    eventId: `evt-${id}`,
    status: 'delivered',
    attempts: [{ attemptNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', statusCode: 200 }],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function dlq(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    deliveryId: `del-${id}`,
    endpointId: 'ep-1',
    endpointUrl: 'https://a.example/hook',
    eventId: `evt-${id}`,
    eventType: 'stream.created',
    reason: 'max retries exceeded',
    attempts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    replayedDeliveryId: null,
    replayedAt: null,
    ...overrides,
  };
}

async function openTab(name: string) {
  await userEvent.click(screen.getByRole('tab', { name }));
}

// ── Subscriptions ────────────────────────────────────────────────────────────

describe('Subscriptions tab', () => {
  it('shows a loading state, then the subscriptions', async () => {
    handlers['/api/webhooks/subscriptions'] = () => ({ body: { data: [subscription] } });
    render(<WebhooksSettingsPage />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading subscriptions/i);
    expect(await screen.findByText('https://merchant.example/hooks')).toBeInTheDocument();
    expect(screen.getByText('stream.created, stream.settled')).toBeInTheDocument();
    expect(screen.getByText('Configured')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    render(<WebhooksSettingsPage />);
    expect(await screen.findByText(/no webhook subscriptions yet/i)).toBeInTheDocument();
  });

  it('shows an auth message for a non-admin (403)', async () => {
    handlers['/api/webhooks/subscriptions'] = () => ({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'Admin role required' } },
    });
    render(<WebhooksSettingsPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/admin session/i);
  });

  it('retries after a server error', async () => {
    let fail = true;
    handlers['/api/webhooks/subscriptions'] = () =>
      fail ? { status: 500, body: { error: { code: 'X' } } } : { body: { data: [subscription] } };
    render(<WebhooksSettingsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load subscriptions/i);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('https://merchant.example/hooks')).toBeInTheDocument();
  });

  it('sends the bearer token when one is provided', async () => {
    render(<WebhooksConsoleContent getAuthToken={() => 'admin-jwt'} />);
    await screen.findByText(/no webhook subscriptions yet/i);
    const [, init] = callsTo('/api/webhooks/subscriptions')[0];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer admin-jwt');
  });
});

// ── Deliveries ───────────────────────────────────────────────────────────────

describe('Deliveries tab', () => {
  it('shows an empty delivery log', async () => {
    render(<WebhooksSettingsPage />);
    await openTab('Deliveries');
    expect(await screen.findByText(/no webhook deliveries yet/i)).toBeInTheDocument();
  });

  it('pages with "Load more" using meta.nextCursor', async () => {
    handlers['/api/webhooks/deliveries'] = (url) =>
      url.includes('cursor=')
        ? { body: { deliveries: [delivery('d3')], meta: { hasNext: false, nextCursor: null, total: 3 } } }
        : {
            body: {
              deliveries: [delivery('d1'), delivery('d2')],
              meta: { hasNext: true, nextCursor: 'cur/1+', total: 3 },
            },
          };
    render(<WebhooksSettingsPage />);
    await openTab('Deliveries');

    expect(await screen.findByText('d1')).toBeInTheDocument();
    expect(callsTo('/api/webhooks/deliveries')[0][0]).toBe('/api/webhooks/deliveries?limit=20');

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('d3')).toBeInTheDocument();
    expect(screen.getByText('d1')).toBeInTheDocument();
    expect(callsTo('/api/webhooks/deliveries')[1][0]).toBe(
      `/api/webhooks/deliveries?limit=20&cursor=${encodeURIComponent('cur/1+')}`,
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('refetches with the chosen page size', async () => {
    render(<WebhooksSettingsPage />);
    await openTab('Deliveries');
    await screen.findByText(/no webhook deliveries yet/i);

    await userEvent.selectOptions(screen.getByLabelText('Page size'), '100');
    await waitFor(() =>
      expect(callsTo('/api/webhooks/deliveries').at(-1)?.[0]).toBe('/api/webhooks/deliveries?limit=100'),
    );
  });

  it('filters by status and endpoint on the client', async () => {
    handlers['/api/webhooks/deliveries'] = () => ({
      body: {
        deliveries: [
          delivery('ok-1'),
          delivery('fail-1', { status: 'failed', endpointUrl: 'https://b.example/hook', endpointId: 'ep-2' }),
        ],
        meta: { hasNext: false, nextCursor: null, total: 2 },
      },
    });
    render(<WebhooksSettingsPage />);
    await openTab('Deliveries');
    await screen.findByText('ok-1');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed');
    expect(screen.queryByText('ok-1')).not.toBeInTheDocument();
    expect(screen.getByText('fail-1')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'all');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'a.example');
    expect(screen.getByText('ok-1')).toBeInTheDocument();
    expect(screen.queryByText('fail-1')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Endpoint'));
    await userEvent.type(screen.getByLabelText('Endpoint'), 'nomatch');
    expect(screen.getByText(/no loaded deliveries match/i)).toBeInTheDocument();
  });

  it('expands the attempt history', async () => {
    handlers['/api/webhooks/deliveries'] = () => ({
      body: {
        deliveries: [
          delivery('d1', {
            status: 'failed',
            attempts: [
              { attemptNumber: 1, timestamp: '2026-01-01T00:00:00.000Z', statusCode: 503 },
              { attemptNumber: 2, timestamp: '2026-01-01T00:01:00.000Z', error: 'timeout' },
            ],
          }),
        ],
        meta: { hasNext: false, nextCursor: null, total: 1 },
      },
    });
    render(<WebhooksSettingsPage />);
    await openTab('Deliveries');

    const toggle = await screen.findByRole('button', { name: /show attempt history for d1/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    const history = screen.getByRole('list', { name: 'Attempt history' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    expect(history).toHaveTextContent('HTTP 503');
    expect(history).toHaveTextContent('timeout');
    expect(screen.getByRole('button', { name: /hide attempt history for d1/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});

// ── Dead letters ─────────────────────────────────────────────────────────────

describe('Dead letters tab', () => {
  it('shows an empty state', async () => {
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');
    expect(await screen.findByText(/dead-letter queue is empty/i)).toBeInTheDocument();
  });

  it('sends one request on a double-click', async () => {
    handlers['/api/webhooks/dlq'] = () => ({ body: { data: [dlq('dlq-1')] } });
    let release!: () => void;
    handlers.replay = () =>
      new Promise((resolve) => {
        release = () => resolve({ body: { data: { alreadyReplayed: false } } });
      });
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');

    const button = await screen.findByRole('button', { name: 'Replay dlq-1' });
    await userEvent.dblClick(button);
    expect(callsTo('replay')).toHaveLength(1);
    expect(callsTo('replay')[0][0]).toBe('/api/webhooks/dlq/dlq-1/replay');
    expect(callsTo('replay')[0][1].method).toBe('POST');

    await act(async () => release());
    expect(await screen.findByText('Replay queued.')).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('shows alreadyReplayed as a neutral message', async () => {
    handlers['/api/webhooks/dlq'] = () => ({ body: { data: [dlq('dlq-1')] } });
    handlers.replay = () => ({ body: { data: { alreadyReplayed: true } } });
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');

    await userEvent.click(await screen.findByRole('button', { name: 'Replay dlq-1' }));
    const message = await screen.findByText(/already replayed/i);
    expect(message).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay dlq-1' })).toBeDisabled();
  });

  it('marks entries the server reports as replayed', async () => {
    handlers['/api/webhooks/dlq'] = () => ({
      body: { data: [dlq('dlq-1', { replayedAt: '2026-01-02T00:00:00.000Z', replayedDeliveryId: 'd9' })] },
    });
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');
    expect(await screen.findByText(/already replayed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay dlq-1' })).toBeDisabled();
  });

  it.each([401, 403])('shows an auth message on %i', async (status) => {
    handlers['/api/webhooks/dlq'] = () => ({ body: { data: [dlq('dlq-1')] } });
    handlers.replay = () => ({ status, body: { error: { code: 'INTERNAL_AUTH_REQUIRED', message: 'no' } } });
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');

    await userEvent.click(await screen.findByRole('button', { name: 'Replay dlq-1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/admin session/i);
  });

  it('treats REPLAY_FAILED as retryable', async () => {
    handlers['/api/webhooks/dlq'] = () => ({ body: { data: [dlq('dlq-1')] } });
    let attempt = 0;
    handlers.replay = () =>
      ++attempt === 1
        ? { status: 502, body: { error: { code: 'REPLAY_FAILED', message: 'worker down' } } }
        : { body: { data: { alreadyReplayed: false } } };
    render(<WebhooksSettingsPage />);
    await openTab('Dead letters');

    await userEvent.click(await screen.findByRole('button', { name: 'Replay dlq-1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/replay failed/i);

    const retry = screen.getByRole('button', { name: 'Replay dlq-1' });
    expect(retry).toBeEnabled();
    expect(retry).toHaveTextContent('Retry replay');
    await userEvent.click(retry);
    expect(await screen.findByText('Replay queued.')).toBeInTheDocument();
    expect(callsTo('replay')).toHaveLength(2);
  });
});

// ── Secret rotation ──────────────────────────────────────────────────────────

describe('Secret rotation dialog', () => {
  const NEW_SECRET = 'n3w-secret-value-that-is-long-enough-0123456789';

  beforeEach(() => {
    handlers['/api/webhooks/rotate'] = () => ({
      body: { data: { activatedAt: '2026-01-01T00:00:00.000Z', previousSecretExpiresAt: '2026-01-02T00:00:00.000Z' } },
    });
  });

  async function openDialog() {
    render(<WebhooksSettingsPage />);
    await screen.findByText(/no webhook subscriptions yet/i);
    await userEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' }));
    return screen.getByRole('dialog');
  }

  it('generates a base64url secret of at least 32 characters', async () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(generateWebhookSecret()).not.toBe(secret);

    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    const input = within(dialog).getByLabelText('New signing secret') as HTMLInputElement;
    expect(input.value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it('rejects a secret shorter than 32 characters without calling the API', async () => {
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('New signing secret'), 'too-short');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(/at least 32 characters/i);
    expect(callsTo('/api/webhooks/rotate')).toHaveLength(0);
  });

  it('shows the server 422 message (e.g. WEBHOOK_SECRET_MUST_DIFFER)', async () => {
    handlers['/api/webhooks/rotate'] = () => ({
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: 'New secret must differ from the current active secret' } },
    });
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('New signing secret'), NEW_SECRET);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/must differ/i);
    expect(screen.queryByTestId('revealed-secret')).not.toBeInTheDocument();
  });

  it('reveals the secret once and forgets it after the dialog closes', async () => {
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText('New signing secret'), NEW_SECRET);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));

    const revealed = (await screen.findByTestId('revealed-secret')) as HTMLInputElement;
    expect(revealed.value).toBe(NEW_SECRET);
    const [, init] = callsTo('/api/webhooks/rotate')[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ secret: NEW_SECRET });

    await userEvent.click(screen.getByRole('button', { name: 'Copy secret to clipboard' }));
    expect(writeText).toHaveBeenCalledWith(NEW_SECRET);
    expect(await screen.findByText('Copied')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    // The Modal shell waits for its exit animation (never fired in jsdom), but
    // the form holding the secret unmounts as soon as the dialog closes.
    expect(screen.queryByTestId('revealed-secret')).not.toBeInTheDocument();

    // Gone from the DOM, storage, URL and logs.
    expect(document.body.innerHTML).not.toContain(NEW_SECRET);
    const storage = [window.localStorage, window.sessionStorage]
      .flatMap((s) => Object.keys(s).map((k) => s.getItem(k)))
      .join('|');
    expect(storage).not.toContain(NEW_SECRET);
    expect(window.location.href).not.toContain(NEW_SECRET);
    for (const spy of logSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(NEW_SECRET);
    }

    // Re-opening starts from an empty form; the secret cannot be retrieved.
    await userEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' }));
    expect(screen.queryByTestId('revealed-secret')).not.toBeInTheDocument();
    expect((screen.getByLabelText('New signing secret') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(NEW_SECRET);

    logSpies.forEach((s) => s.mockRestore());
  });

  it('traps focus inside the dialog', async () => {
    const dialog = await openDialog();
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
    );
    const last = focusables[focusables.length - 1];
    last.focus();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await userEvent.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });
});

// ── Accessibility ────────────────────────────────────────────────────────────

describe('accessibility', () => {
  it('has no axe violations on each tab', async () => {
    handlers['/api/webhooks/subscriptions'] = () => ({ body: { data: [subscription] } });
    handlers['/api/webhooks/deliveries'] = () => ({
      body: { deliveries: [delivery('d1')], meta: { hasNext: true, nextCursor: 'c', total: 2 } },
    });
    handlers['/api/webhooks/dlq'] = () => ({ body: { data: [dlq('dlq-1')] } });
    const { container } = render(<WebhooksSettingsPage />);

    await screen.findByText('https://merchant.example/hooks');
    expect(await axe(container)).toHaveNoViolations();

    await openTab('Deliveries');
    await screen.findByText('d1');
    await userEvent.click(screen.getByRole('button', { name: /show attempt history/i }));
    expect(await axe(container)).toHaveNoViolations();

    await openTab('Dead letters');
    await screen.findByText('dlq-1');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the rotation dialog open', async () => {
    render(<WebhooksSettingsPage />);
    await screen.findByText(/no webhook subscriptions yet/i);
    await userEvent.click(screen.getByRole('button', { name: 'Rotate signing secret' }));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
