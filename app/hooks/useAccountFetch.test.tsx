import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAccountFetch } from './useAccountFetch';
import { AccountFetchCoordinator } from '@/lib/accountFetchCoordinator';

describe('useAccountFetch', () => {
  let coordinator: AccountFetchCoordinator;

  beforeEach(() => {
    coordinator = new AccountFetchCoordinator();
  });

  afterEach(() => {
    coordinator.abortAll();
  });

  it('fetches data on initial render with active accountId', async () => {
    const fetcher = jest.fn().mockResolvedValue({ streams: ['stream-1'] });

    const { result } = renderHook(
      ({ accountId }) =>
        useAccountFetch(accountId, fetcher, { coordinator }),
      { initialProps: { accountId: 'GA_ALICE' } }
    );

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual({ streams: ['stream-1'] });
    expect(result.current.error).toBeNull();
    expect(result.current.accountId).toBe('GA_ALICE');
  });

  it('aborts and replaces data when accountId switches', async () => {
    const fetcher = jest.fn().mockImplementation(async (signal: AbortSignal) => {
      const activeAccount = coordinator.getActiveAccountId();
      if (activeAccount === 'GA_ALICE') {
        // Alice fetch is slow
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 80);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('Aborted'));
          });
        });
        return { streams: ['alice-stream'] };
      } else {
        // Bob fetch is fast
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { streams: ['bob-stream'] };
      }
    });

    const { result, rerender } = renderHook(
      ({ accountId }) =>
        useAccountFetch(accountId, fetcher, { coordinator }),
      { initialProps: { accountId: 'GA_ALICE' } }
    );

    expect(result.current.isLoading).toBe(true);

    // Switch account to Bob before Alice's fetch resolves
    act(() => {
      rerender({ accountId: 'GA_BOB' });
    });

    expect(result.current.accountId).toBe('GA_BOB');

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual({ streams: ['bob-stream'] });
    });

    // Wait past Alice's original delay to ensure Alice's response NEVER overwrites Bob's data
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(result.current.data).toEqual({ streams: ['bob-stream'] });
  });

  it('resets state cleanly when accountId becomes null (disconnected)', async () => {
    const fetcher = jest.fn().mockResolvedValue({ streams: ['stream-1'] });

    const { result, rerender } = renderHook(
      ({ accountId }: { accountId: string | null }) =>
        useAccountFetch(accountId, fetcher, { coordinator }),
      { initialProps: { accountId: 'GA_ALICE' as string | null } }
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual({ streams: ['stream-1'] });
    });

    // Disconnect
    act(() => {
      rerender({ accountId: null });
    });

    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.accountId).toBeNull();
  });

  it('isolates errors so a failed fetch for an old account does not set error for a new account', async () => {
    const fetcher = jest.fn().mockImplementation(async () => {
      const active = coordinator.getActiveAccountId();
      if (active === 'GA_ALICE') {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('Alice network failure');
      } else {
        return { streams: ['bob-ok'] };
      }
    });

    const { result, rerender } = renderHook(
      ({ accountId }) =>
        useAccountFetch(accountId, fetcher, { coordinator }),
      { initialProps: { accountId: 'GA_ALICE' } }
    );

    // Switch to Bob before Alice's error throws
    act(() => {
      rerender({ accountId: 'GA_BOB' });
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.data).toEqual({ streams: ['bob-ok'] });
    });

    // Error must be null
    expect(result.current.error).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('refetch triggers a fresh fetch for the currently active account', async () => {
    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(async () => {
      callCount++;
      return { count: callCount };
    });

    const { result } = renderHook(
      () => useAccountFetch('GA_ALICE', fetcher, { coordinator })
    );

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 1 });
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toEqual({ count: 2 });
  });
});
