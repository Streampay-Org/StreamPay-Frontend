/** @jest-environment node */

import { GET } from './route';
import { signToken } from '@/app/lib/auth';
import {
  setWebhookSubscriptionStore,
  WebhookSubscription,
} from '@/app/lib/webhook-store';

const SECRET = 'whsec_super_secret_value_that_must_never_leak_0123456789';

function sub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
  return {
    id: 'whs_1',
    url: 'https://example.com/hooks',
    eventTypes: ['stream.created'],
    secret: SECRET,
    description: 'Primary endpoint',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function request(role?: string, query = ''): Request {
  const headers: Record<string, string> = {};
  if (role) {
    headers.authorization = `Bearer ${signToken(`${role}-wallet`, { role, actorId: `${role}-1` })}`;
  }
  return new Request(`http://localhost/api/webhooks/subscriptions${query}`, { headers });
}

describe('GET /api/webhooks/subscriptions', () => {
  const list = jest.fn();

  beforeEach(() => {
    list.mockReset();
    list.mockResolvedValue([sub(), sub({ id: 'whs_2', secret: null, status: 'inactive' })]);
    setWebhookSubscriptionStore({ list });
  });

  afterAll(() => setWebhookSubscriptionStore(null));

  it('returns subscriptions for an admin', async () => {
    const res = await GET(request('admin'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta.total).toBe(2);
    expect(body.data.map((s: { id: string }) => s.id)).toEqual(['whs_1', 'whs_2']);
    expect(body.data[0]).toMatchObject({ hasSecret: true, url: 'https://example.com/hooks' });
    expect(body.data[1].hasSecret).toBe(false);
  });

  it('never returns the signing secret', async () => {
    const res = await GET(request('admin'));
    const raw = await res.text();

    expect(raw).not.toContain(SECRET);
    for (const item of JSON.parse(raw).data) {
      expect(item).not.toHaveProperty('secret');
    }
  });

  it('returns 401 without a bearer token', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    expect(list).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin role', async () => {
    const res = await GET(request('user'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(list).not.toHaveBeenCalled();
  });

  it('forwards status and event_type filters to the store', async () => {
    await GET(request('admin', '?status=active&event_type=stream.created'));
    expect(list).toHaveBeenCalledWith({ status: 'active', eventType: 'stream.created' });
  });

  it('rejects an unknown status filter', async () => {
    const res = await GET(request('admin', '?status=deleted'));
    expect(res.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns an empty list', async () => {
    list.mockResolvedValue([]);
    const res = await GET(request('admin'));
    expect(await res.json()).toEqual({ data: [], meta: { total: 0 } });
  });

  it('returns 500 when the store fails, without leaking details', async () => {
    list.mockRejectedValue(new Error(`db down ${SECRET}`));
    const res = await GET(request('admin'));
    const raw = await res.text();
    expect(res.status).toBe(500);
    expect(raw).not.toContain(SECRET);
  });
});
